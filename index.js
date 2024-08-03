const express = require("express");
const bcrypt = require("bcrypt");
const { MongoClient, ObjectId } = require("mongodb");
const WebSocket = require("ws");
const schedule = require("node-schedule");
const dotenv = require("dotenv");
const cors = require("cors");
const requestIp = require("request-ip");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const MongoDBStore = require("connect-mongodb-session")(session);

// Load environment variables from .env file
dotenv.config();

// Configuration
const saltRounds = 10;
const PORT = process.env.PORT || 3500;
const MONGODB_URI = process.env.MONGODB_URI || "your-mongodb-uri";
const DB_NAME = process.env.DB_NAME || "spacex";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "users";
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3500";
const CLIENT_URI = process.env.CLIENT_URI;

// MongoDB client
const client = new MongoClient(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Session store
const store = new MongoDBStore({
  uri: MONGODB_URI,
  collection: "sessions",
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
    origin: CLIENT_URI, // Replace with your client URL
    credentials: true,
  })
);

// Middleware to parse JSON request bodies and cookies
server.use(express.json());
server.use(cookieParser());

// Middleware to handle sessions
server.use(
  session({
    secret: process.env.SESSION_SECRET || "your-secret-key",
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: {
      httpOnly: true, // Secure the cookie by making it inaccessible to JavaScript
      secure: process.env.NODE_ENV === "production", // Use secure cookies in production
      maxAge: 24 * 60 * 60 * 1000, // 1 day
      sameSite: "Lax", // Provides a good balance between security and usability
    },
  })
);

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

const ranks = [
  { rank: "SEG", hours: 6, payment: 10 },
  { rank: "TEC", hours: 8, payment: 20 },
  { rank: "LOG", hours: 10, payment: 30 },
  { rank: "HR", hours: 12, payment: 40 },
  { rank: "DIR", hours: 14, payment: 50 },
  { rank: "OP", hours: 16, payment: 60 },
];

// POST route to add a new user
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

    req.session.user = { name: user.name };
    req.session.save((err) => {
      if (err) {
        console.error("Session save error:", err);
        return res.status(500).json({ error: "Error saving session" });
      }
      res.status(200).json({ message: "Login successful" });
    });
  } catch (e) {
    console.error("Error in /api/login route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

// GET route to validate session
server.get("/api/validate-session", (req, res) => {
  if (req.session.user) {
    console.log("Session valid for user:", req.session.user);
    res.status(200).json({ message: "Session valid" });
  } else {
    console.log("Session invalid");
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

// POST route to handle form submissions
server.post(`/api/worker`, async (req, res) => {
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
server.put(`/api/worker/:id/mark-paid`, async (req, res) => {
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
server.get(`/api/workers`, async (req, res) => {
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
server.get(`/api/ranks`, async (req, res) => {
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
server.put(`/api/worker/:id`, async (req, res) => {
  const { id } = req.params;
  const { usuario, category, savedPayment, halfTime } = req.body;

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
server.get(`/api/worker/:id`, async (req, res) => {
  const { id } = req.params;

  try {
    const collection = db.collection("workers");
    const worker = await collection.findOne({ _id: new ObjectId(id) });

    if (!worker) {
      return res.status(404).json({ error: "Worker not found" });
    }

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
server.post(`/api/timing`, async (req, res) => {
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
          totalSeconds: 0, // Store total elapsed time in seconds
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
            createdBy: user, // Update createdBy field
          };
        } else if (currentRecord.status === "confirmed") {
          update = {
            status: "active",
            startTime: new Date(),
            pauseTime: null,
            endTime: null,
            totalSeconds: currentRecord.totalSeconds,
            createdBy: user, // Update createdBy field
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
          };
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
        if (
          currentRecord.status === "active" ||
          currentRecord.status === "paused"
        ) {
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

          // If the same user starts and confirms, add totalMinutes to the user's assistedTimes
          if (currentRecord.createdBy === user) {
            const minutesToAdd =
              update.totalMinutes - (currentRecord.totalMinutes || 0);
            console.log("minutesToAdd:", minutesToAdd);
            const updateResult = await db.collection(COLLECTION_NAME).updateOne(
              { name: user },
              {
                $inc: {
                  totalMinutes: minutesToAdd,
                  assistedTimes: minutesToAdd,
                },
              },
              { upsert: true }
            );
            console.log("Update result:", updateResult);
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

// GET route to fetch workers with their timing status
server.get(`/api/workers/timing`, async (req, res) => {
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
server.get(`/api/validate-payments`, async (req, res) => {
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
          { $match: { usuario: worker.usuario, status: "confirmed" } },
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

      const requiredHours = rankMap[worker.category].hours;
      const paymentAmount = rankMap[worker.category].payment;
      const totalWorkerSeconds =
        totalTime.length > 0 ? totalTime[0].totalSeconds : 0;

      const totalWorkerHours = Math.floor(totalWorkerSeconds / 3600);
      const totalWorkerMinutes = Math.floor((totalWorkerSeconds % 3600) / 60);

      if (
        (worker.halfTime && totalWorkerHours >= requiredHours / 2) ||
        totalWorkerHours >= requiredHours
      ) {
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
      const requiredAssistances = rankMap["JD"]?.assistances || 30;
      const paymentAmount = rankMap["JD"]?.payment || 20;
      const paid = user.paid;
      if (assistances >= requiredAssistances) {
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
    const timesCollection = db.collection("times");

    // Delete all records where savedPayment is false
    await timesCollection.deleteMany({});
    console.log(
      "Times collection cleared after payroll, except for records with savedPayment true."
    );
  } catch (e) {
    console.error("Error clearing times collection:", e);
  }
};

schedule.scheduleJob("0 2 * * 0", cleanupTimesCollection);

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
