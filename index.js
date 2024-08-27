const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { MongoClient, ObjectId } = require("mongodb");
const WebSocket = require("ws");
const schedule = require("node-schedule");
const dotenv = require("dotenv");
const cors = require("cors");
const requestIp = require("request-ip");
const cookieParser = require("cookie-parser");

// Load environment variables from .env file
dotenv.config();

// Configuration
const saltRounds = 10;
const PORT = process.env.PORT || 3500;
const MONGODB_URI = process.env.MONGODB_URI || "your-mongodb-uri";
const DB_NAME = process.env.DB_NAME || "spacex";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "users";
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3500";
const JWT_SECRET = process.env.JWT_SECRET || "your-jwt-secret";

// MongoDB client
const client = new MongoClient(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const validateUser = async (name) => {
  const url = `https://www.habbo.es/habbo-imaging/avatarimage?user=${name}&action=none&direction=2&head_direction=2&gesture=&size=l&headonly=0`;
  try {
    const { default: fetch } = await import("node-fetch");
    const response = await fetch(url);
    return response.status !== 404;
  } catch (error) {
    console.error("Error fetching image URL:", error);
    return false;
  }
};

// Initialize Express server
const server = express();

// Enable CORS for all routes
server.use(
  cors({
    origin: process.env.CLIENT_URI,
    credentials: true,
  })
);

// Middleware to parse JSON request bodies and cookies
server.use(express.json());
server.use(cookieParser());

// Middleware to get IP address
server.use(requestIp.mw());

// Connect to MongoDB once and reuse the client
let db;

client
  .connect()
  .then(() => {
    db = client.db(DB_NAME);
    console.log("Connected to MongoDB");
  })
  .catch((error) => {
    console.error("Error connecting to MongoDB:", error);
  });

// const ranks = [
//   { rank: "SEG", hours: 6, payment: 10 },
//   { rank: "TEC", hours: 8, payment: 20 },
//   { rank: "LOG", hours: 10, payment: 30 },
//   { rank: "HR", hours: 12, payment: 40 },
//   { rank: "DIR", hours: 14, payment: 50 },
//   { rank: "OP", hours: 16, payment: 60 },
// ];

const resetAssitances = async () => {
  try {
    await client.connect();
    const users = db.collection("users");

    const result = await users.updateMany(
      {},
      {
        $set: {
          totalMinutes: 0,
          assistedTimes: 0,
        },
      }
    );

    console.log(`${result.modifiedCount} documents were updated.`);
  } finally {
    await client.close();
  }
};

// resetAssitances();

const resetAllPaidStatus = async () => {
  try {
    // Reset 'paid' property for all workers
    await client.connect();
    const workersCollection = db.collection("workers");
    const usersCollection = db.collection(COLLECTION_NAME);

    const workersResult = await workersCollection.updateMany(
      {},
      { $set: { paid: false } }
    );

    console.log(
      `All workers' paid status reset to false. Modified count: ${workersResult.modifiedCount}`
    );

    // Reset 'paid' property for all users
    const usersResult = await usersCollection.updateMany(
      {},
      { $set: { paid: false } }
    );

    console.log(
      `All users' paid status reset to false. Modified count: ${usersResult.modifiedCount}`
    );

    return {
      success: true,
      message: "All workers' and users' paid status reset to false",
      workersModifiedCount: workersResult.modifiedCount,
      usersModifiedCount: usersResult.modifiedCount,
    };
  } catch (e) {
    console.error("Error resetting paid status:", e);
    return {
      success: false,
      message: "Error resetting paid status",
      error: e,
    };
  }
};

const processPayroll = async () => {
  try {
    // Your payroll processing logic here...

    // After payroll processing, reset all workers' paid status
    const result = await resetAllPaidStatus();

    if (result.success) {
      console.log(result.message);
    } else {
      console.error(result.message, result.error);
    }
  } catch (error) {
    console.error("Error during payroll processing:", error);
  }
};

// Example of manually triggering the payroll process
// processPayroll();

const validateWorkerDates = async (worker) => {
  const today = new Date();
  let updated = false;

  if (
    worker.savedPaymentEndDate &&
    new Date(worker.savedPaymentEndDate) < today
  ) {
    worker.savedPayment = false;
    updated = true;
  }

  if (worker.halfTimeEndDate && new Date(worker.halfTimeEndDate) < today) {
    worker.halfTime = false;
    updated = true;
  }

  if (updated) {
    await db.collection("workers").updateOne(
      { _id: worker._id },
      {
        $set: {
          savedPayment: worker.savedPayment,
          halfTime: worker.halfTime,
        },
      }
    );
  }

  return worker;
};

server.post(`/api/users`, async (req, res) => {
  const { name, password } = req.body;
  const ip = req.clientIp;
  if (!name || !password) {
    return res.status(400).json({ error: "Name and password are required" });
  }

  // Validate the user's name
  const isValid = await validateUser(name);
  if (!isValid) {
    return res.status(400).json({ error: "Invalid user" });
  }

  try {
    const collection = db.collection(COLLECTION_NAME);

    // Check if the user already exists
    const existingUser = await collection.findOne({ name });
    if (existingUser) {
      return res.status(409).json({ error: "User already exists" });
    }

    // Hash the password before storing
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert the new user into the collection
    const result = await collection.insertOne({
      name,
      password: hashedPassword,
      ip, // Store the IP address
      totalMinutes: 0, // Initialize totalMinutes
      assistedTimes: 0, // Initialize assistedTimes
      paid: false,
    });
    const insertedUser = await collection.findOne({ _id: result.insertedId });

    res
      .status(201)
      .json({ message: "User added successfully", user: insertedUser });
  } catch (e) {
    console.error("Error in /api/users route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

server.get("/api/server-time", (req, res) => {
  const serverTime = new Date();
  res.status(200).json({ serverTime });
});

server.put(`/api/user/:name/mark-paid`, async (req, res) => {
  const { name } = req.params;
  const { paid } = req.body;

  try {
    const result = await db
      .collection(COLLECTION_NAME)
      .updateOne({ name }, { $set: { paid } });

    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const updatedUser = await db.collection(COLLECTION_NAME).findOne({ name });

    res.status(200).json({
      message: "User paid status updated successfully",
      user: updatedUser,
    });
  } catch (e) {
    console.error("Error in /api/user/:name/mark-paid route:", e);
    res.status(500).json({ error: "Error updating the user" });
  }
});

// POST route to login a user
server.post(`/api/login`, async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: "Name and password are required" });
  }

  try {
    const collection = db.collection(COLLECTION_NAME);

    const user = await collection.findOne({ name });
    if (!user) {
      return res.status(401).json({ error: "Invalid name or password" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: "Invalid name or password" });
    }

    // Generate JWT without expiration
    const token = jwt.sign({ name: user.name }, JWT_SECRET);

    res.status(200).json({ message: "Login successful", token });
  } catch (e) {
    console.error("Error in /api/login route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

// Middleware to authenticate and authorize JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// POST route to handle form submissions
server.post(`/api/worker`, authenticateToken, async (req, res) => {
  const { usuario, registradoPor, fecha, category } = req.body;
  if (!usuario || !registradoPor || !fecha || !category) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const isValid = await validateUser(usuario);
  if (!isValid) {
    return res.status(400).json({ error: "Invalid user" });
  }

  try {
    const collection = db.collection("workers");

    // Check if the worker already exists
    const existingWorker = await collection.findOne({ usuario });
    if (existingWorker) {
      return res.status(409).json({ error: "Worker already exists" });
    }

    // Insert the new worker into the collection with default values for savedPayment, halfTime, and paid
    const result = await collection.insertOne({
      usuario,
      registradoPor,
      fecha,
      category,
      savedPayment: false,
      halfTime: false,
      paid: false, // Add default value for paid
    });
    const insertedWorker = await collection.findOne({ _id: result.insertedId });

    res
      .status(201)
      .json({ message: "Worker added successfully", worker: insertedWorker });
  } catch (e) {
    console.error("Error in /api/worker route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

// PUT route to update the paid status of a worker
server.put(`/api/worker/:id/mark-paid`, authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { paid } = req.body;

  try {
    const collection = db.collection("workers");

    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { paid } }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: "Worker not found" });
    }

    const updatedWorker = await collection.findOne({ _id: new ObjectId(id) });

    res.status(200).json({
      message: "Worker paid status updated successfully",
      worker: updatedWorker,
    });

    // Broadcast the update via WebSocket
    broadcastUpdate({
      action: "mark-paid",
      worker: updatedWorker,
    });
  } catch (e) {
    console.error("Error in /api/worker/:id/mark-paid route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

// GET route to fetch all workers
server.get(`/api/workers`, authenticateToken, async (req, res) => {
  try {
    const collection = db.collection("workers");

    // Fetch all workers from the collection, sorted by '_id' in descending order
    const workers = await collection.find({}).sort({ _id: -1 }).toArray();

    res.status(200).json(workers);
  } catch (e) {
    console.error("Error in /api/workers route:", e);
    res.status500().json({ error: "Error connecting to the database" });
  }
});

// GET route to fetch ranks
server.get(`/api/ranks`, authenticateToken, async (req, res) => {
  try {
    const collection = db.collection("ranks");
    const ranks = await collection.find({}).toArray();
    res.status(200).json(ranks);
  } catch (e) {
    console.error("Error in /api/ranks route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

// PUT route to update a worker
server.put(`/api/worker/:id`, authenticateToken, async (req, res) => {
  const { id } = req.params;
  const {
    usuario,
    category,
    savedPayment,
    halfTime,
    savedPaymentEndDate,
    halfTimeEndDate,
  } = req.body;

  if (!usuario || !category) {
    return res.status(400).json({ error: "Usuario and category are required" });
  }

  try {
    const collection = db.collection("workers");

    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          usuario,
          category,
          savedPayment,
          halfTime,
          savedPaymentEndDate,
          halfTimeEndDate,
        },
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: "Worker not found" });
    }

    const updatedWorker = await collection.findOne({ _id: new ObjectId(id) });

    res.status(200).json({
      message: "Worker updated successfully",
      worker: updatedWorker,
    });
  } catch (e) {
    console.error("Error in /api/worker/:id route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

// GET route to fetch a worker's details by ID
server.get(`/api/worker/:id`, authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const collection = db.collection("workers");
    let worker = await collection.findOne({ _id: new ObjectId(id) });

    if (!worker) {
      return res.status(404).json({ error: "Worker not found" });
    }

    worker = await validateWorkerDates(worker);

    res.status(200).json(worker);
  } catch (e) {
    console.error("Error in /api/worker/:id route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

const calculateTotalTime = (startTime, endTime) => {
  const duration = (new Date(endTime) - new Date(startTime)) / 1000; // Duration in seconds
  const minutes = Math.floor(duration / 60);
  const hours = Math.floor(minutes / 60);
  return { hours, minutes: minutes % 60, seconds: Math.floor(duration) }; // Return duration in seconds as an integer
};

// WebSocket setup
const wss = new WebSocket.Server({ noServer: true });

const broadcastUpdate = (message) => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
};

// POST route to manage timing
server.post(`/api/timing`, authenticateToken, async (req, res) => {
  const { usuario, action, username } = req.body;
  if (!usuario || !action) {
    return res.status(400).json({ error: "Usuario and action are required" });
  }

  const user = username;

  try {
    const collection = db.collection("times");

    let currentRecord = await collection.findOne({
      usuario,
      status: { $in: ["active", "paused", "confirmed"] },
    });

    if (!currentRecord) {
      if (action === "start") {
        const newRecord = {
          usuario,
          status: "active",
          startTime: new Date(),
          pauseTime: null,
          endTime: null,
          totalSeconds: 0,
          createdBy: user,
          createdAt: new Date(),
        };
        await collection.insertOne(newRecord);
        broadcastUpdate({ action: "start", timing: newRecord });
        return res.status(201).json({
          message: "Timing started successfully",
          timing: newRecord,
        });
      } else {
        return res
          .status(404)
          .json({ error: "No timing record found to update" });
      }
    }

    let update = {};
    switch (action) {
      case "start":
        if (currentRecord.status === "paused") {
          update = {
            status: "active",
            startTime: new Date(),
            pauseTime: null,
            createdBy: user,
          };
        } else if (currentRecord.status === "confirmed") {
          update = {
            status: "active",
            startTime: new Date(),
            pauseTime: null,
            endTime: null,
            totalSeconds: currentRecord.totalSeconds,
            createdBy: user,
          };
        } else {
          return res.status(409).json({ error: "Timing is already active" });
        }
        await collection.updateOne(
          { _id: currentRecord._id },
          { $set: update }
        );
        timing = { ...currentRecord, ...update };
        broadcastUpdate({ action: "start", timing });
        break;
      case "pause":
        if (currentRecord.status === "active") {
          const { seconds } = calculateTotalTime(
            currentRecord.startTime,
            new Date()
          );
          update = {
            status: "paused",
            pauseTime: new Date(),
            totalSeconds: currentRecord.totalSeconds + seconds,
            pausedBy: user,
          };

          const minutesToAdd = Math.floor(seconds / 60);
          if (minutesToAdd > 0) {
            await db.collection(COLLECTION_NAME).updateOne(
              { name: currentRecord.createdBy },
              {
                $inc: {
                  totalMinutes: minutesToAdd,
                  assistedTimes: minutesToAdd,
                },
              },
              { upsert: true }
            );
          }

          await collection.updateOne(
            { _id: currentRecord._id },
            { $set: update }
          );
          timing = { ...currentRecord, ...update };
          broadcastUpdate({ action: "pause", timing });
        } else {
          return res
            .status(409)
            .json({ error: "Only active timing can be paused" });
        }
        break;
      case "confirm":
        if (["active", "paused"].includes(currentRecord.status)) {
          const endTime = new Date();
          const { seconds } = calculateTotalTime(
            currentRecord.startTime,
            endTime
          );
          update = {
            status: "confirmed",
            endTime: endTime,
            totalSeconds: currentRecord.totalSeconds + seconds,
            totalMinutes: Math.floor(
              (currentRecord.totalSeconds + seconds) / 60
            ),
            totalHours: Math.floor(
              (currentRecord.totalSeconds + seconds) / 3600
            ),
            confirmedBy: user,
          };
          const minutesToAdd = Math.floor(seconds / 60);
          if (minutesToAdd > 0) {
            await db.collection(COLLECTION_NAME).updateOne(
              { name: currentRecord.createdBy },
              {
                $inc: {
                  totalMinutes: minutesToAdd,
                  assistedTimes: minutesToAdd,
                },
              },
              { upsert: true }
            );
          }
          await collection.updateOne(
            { _id: currentRecord._id },
            { $set: update }
          );
          timing = { ...currentRecord, ...update };
          broadcastUpdate({ action: "confirm", timing });
        } else {
          return res
            .status(409)
            .json({ error: "Timing has already been confirmed" });
        }
        break;
      case "transfer":
        if (["active", "paused"].includes(currentRecord.status)) {
          const { seconds } = calculateTotalTime(
            currentRecord.startTime,
            new Date()
          );

          const minutesToAdd = Math.floor(seconds / 60);
          if (minutesToAdd > 0) {
            await db.collection(COLLECTION_NAME).updateOne(
              { name: currentRecord.createdBy },
              {
                $inc: {
                  totalMinutes: minutesToAdd,
                  assistedTimes: minutesToAdd,
                },
              },
              { upsert: true }
            );
          }

          update = {
            createdBy: user,
          };

          await collection.updateOne(
            { _id: currentRecord._id },
            { $set: update }
          );
          timing = { ...currentRecord, ...update };
          broadcastUpdate({ action: "transfer", timing });
        } else {
          return res.status(409).json({
            error: "Timing cannot be transferred unless it is active or paused",
          });
        }
        break;
      default:
        return res.status(400).json({ error: "Invalid action" });
    }

    const updatedRecord = await collection.findOne({ _id: currentRecord._id });
    res.status(200).json({
      message: "Timing updated successfully",
      timing: updatedRecord,
    });
  } catch (e) {
    console.error("Error in /api/timing route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

server.get(`/api/users/jd`, authenticateToken, async (req, res) => {
  try {
    const collection = db.collection(COLLECTION_NAME);

    // Find users with category "JD"
    const jdUsers = await collection.find({ category: "JD" }).toArray();

    // Check if any users with category "JD" are found
    if (jdUsers.length === 0) {
      return res
        .status(404)
        .json({ message: "No users with category 'JD' found" });
    }

    // Return the users with category "JD" and their assistedTimes
    res.status(200).json(
      jdUsers.map((user) => ({
        name: user.name,
        assistedTimes: user.assistedTimes,
        totalMinutes: user.totalMinutes,
        paid: user.paid,
      }))
    );
  } catch (e) {
    console.error("Error in /api/users/jd route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

// GET route to fetch workers with their timing status
server.get(`/api/workers/timing`, authenticateToken, async (req, res) => {
  try {
    const workersCollection = db.collection("workers");
    const timesCollection = db.collection("times");

    const workers = await workersCollection.find({}).toArray();
    const times = await timesCollection.find({}).toArray();

    const workersWithTimingStatus = workers.map((worker) => {
      const timing = times.find(
        (t) => t.usuario === worker.usuario && t.status !== "history"
      );
      return {
        ...worker,
        timingStatus: timing ? timing.status : "inactive",
        startTime: timing ? timing.startTime : null,
        pauseTime: timing ? timing.pauseTime : null,
        totalHours: timing ? timing.totalHours : 0,
        totalMinutes: timing ? timing.totalMinutes : 0,
        totalSeconds: timing ? timing.totalSeconds : 0,
        createdBy: timing ? timing.createdBy : null,
        confirmedBy: timing ? timing.confirmedBy : null,
      };
    });

    res.status(200).json(workersWithTimingStatus);
  } catch (e) {
    console.error("Error in /api/workers/timing route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

// GET route to validate workers' payment eligibility
server.get(`/api/validate-payments`, authenticateToken, async (req, res) => {
  try {
    const workersCollection = db.collection("workers");
    const timesCollection = db.collection("times");
    const ranksCollection = db.collection("ranks");
    const usersCollection = db.collection(COLLECTION_NAME);

    const workers = await workersCollection.find({}).toArray();
    const ranks = await ranksCollection.find({}).toArray();
    const users = await usersCollection.find({}).toArray();

    const rankMap = {};
    ranks.forEach((rank) => {
      rankMap[rank.rank] = {
        hours: rank.hours,
        payment: rank.payment,
        assistances: rank.assistances,
      };
    });
    const workersToPay = [];

    // Validate workers
    for (const worker of workers) {
      const totalTime = await timesCollection
        .aggregate([
          { $match: { usuario: worker.usuario } },
          {
            $group: {
              _id: "$usuario",
              totalHours: { $sum: "$totalHours" },
              totalMinutes: { $sum: "$totalMinutes" },
              totalSeconds: { $sum: "$totalSeconds" },
            },
          },
        ])
        .toArray();

      const rankDetails = rankMap[worker.category];
      if (!rankDetails) {
        console.warn(`No rank details found for category: ${worker.category}`);
        continue;
      }

      const requiredHours = rankDetails.hours;
      const paymentAmount = rankDetails.payment;
      const totalWorkerSeconds =
        totalTime.length > 0 ? totalTime[0].totalSeconds : 0;

      const totalWorkerHours = Math.floor(totalWorkerSeconds / 3600);
      const totalWorkerMinutes = Math.floor((totalWorkerSeconds % 3600) / 60);

      if (
        (worker.halfTime && totalWorkerHours >= requiredHours / 2) ||
        totalWorkerHours >= requiredHours
      ) {
        console.log(worker);
        workersToPay.push({
          ...worker,
          halfTime: worker.halfTime,
          savedPayment: worker.savedPayment,
          totalHours: totalWorkerHours,
          totalMinutes: totalWorkerMinutes,
          paid: worker.paid,
          paymentAmount,
        });
      }
    }

    // Validate users with JD rank
    const usersToPay = [];
    for (const user of users) {
      const totalMinutes = user.totalMinutes || 0;
      const assistances = Math.floor(totalMinutes / 60);
      const requiredAssistances = rankMap["JD"]?.assistances || 15;
      const paymentAmount = rankMap["JD"]?.payment || 20;
      const paid = user.paid;
      if (assistances >= requiredAssistances && user.category === "JD") {
        usersToPay.push({
          name: user.name,
          assistances,
          totalMinutes,
          paymentAmount,
          paid,
        });
      }
    }

    res.status(200).json({ workersToPay, usersToPay });
  } catch (e) {
    console.error("Error in /api/validate-payments route:", e);
    res.status(500).json({ error: "Error validating payments" });
  }
});

// Schedule cleanup of times collection every Sunday after payroll
const cleanupTimesCollection = async () => {
  try {
    const workersCollection = db.collection("workers");
    const timesCollection = db.collection("times");

    // Retrieve all workers
    const workers = await workersCollection.find({}).toArray();

    // Filter out workers with savedPayment === false
    const workersToRemoveTimes = workers.filter(
      (worker) => !worker.savedPayment
    );

    // Get the list of usernames of the workers to remove times for
    const usernamesToRemoveTimes = workersToRemoveTimes.map(
      (worker) => worker.usuario
    );

    // Delete times documents for the workers with savedPayment === false
    await timesCollection.deleteMany({
      usuario: { $in: usernamesToRemoveTimes },
    });

    console.log(
      "Times collection cleared for workers with savedPayment set to false."
    );
  } catch (e) {
    console.error("Error clearing times collection:", e);
  }
};

const sumTotalMinutesFromTimes = async () => {
  try {
    await client.connect();

    const timesCollection = db.collection("times");
    const result = await timesCollection
      .aggregate([
        {
          $group: {
            _id: null,
            totalMinutes: { $sum: "$totalMinutes" },
          },
        },
      ])
      .toArray();

    const totalMinutes = result.length > 0 ? result[0].totalMinutes : 0;
    console.log("Total Minutes from times collection:", totalMinutes);
    return totalMinutes;
  } catch (error) {
    console.error("Error summing total minutes from times collection:", error);
    return 0;
  }
};

const sumTotalMinutesFromUsers = async () => {
  try {
    await client.connect();

    const usersCollection = db.collection(COLLECTION_NAME);
    const result = await usersCollection
      .aggregate([
        {
          $group: {
            _id: null,
            totalMinutes: { $sum: "$totalMinutes" },
          },
        },
      ])
      .toArray();

    const totalMinutes = result.length > 0 ? result[0].totalMinutes : 0;
    console.log("Total Minutes from users collection:", totalMinutes);
    return totalMinutes;
  } catch (error) {
    console.error("Error summing total minutes from users collection:", error);
    return 0;
  }
};

const getTotalMinutes = async () => {
  try {
    const totalMinutesFromTimes = await sumTotalMinutesFromTimes();
    const totalMinutesFromUsers = await sumTotalMinutesFromUsers();

    console.log(totalMinutesFromTimes);
    console.log(totalMinutesFromUsers);

    return totalMinutesFromTimes;
  } catch (error) {
    console.error("Error getting total minutes:", error);
  }
};

// Call the function to get the grand total minutes
getTotalMinutes();

// Schedule cleanup of times collection every Sunday at 5 PM
schedule.scheduleJob("0 23 * * 0", cleanupTimesCollection);

// Start the server
const serverInstance = server.listen(PORT, () => {
  console.log(`Server is running on ${API_BASE_URL}`);
});

// WebSocket upgrade handling
serverInstance.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

// GET route to validate session
server.get("/api/validate-session", authenticateToken, (req, res) => {
  if (req.user) {
    res.status(200).json({ message: "Session valid" });
  } else {
    res.status(401).json({ message: "Session invalid" });
  }
});

// POST route to logout
server.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Error logging out" });
    }
    res.clearCookie("connect.sid");
    res.status(200).json({ message: "Logout successful" });
  });
});
