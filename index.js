const express = require("express");
const bcrypt = require("bcrypt");
const { MongoClient } = require("mongodb");
const WebSocket = require("ws");
const schedule = require("node-schedule");
const dotenv = require("dotenv");
const cors = require("cors");

// Load environment variables from .env file
dotenv.config();

// Configuration
const saltRounds = 10;
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "your-mongodb-uri";
const DB_NAME = process.env.DB_NAME || "spacex";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "users";
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3500";

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
server.use(cors());

// Middleware to parse JSON request bodies
server.use(express.json());

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

// POST route to add a new user
server.post(`/api/users`, async (req, res) => {
  const { name, password } = req.body;
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

// POST route to login a user
server.post(`/api/login`, async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: "Name and password are required" });
  }

  try {
    const collection = db.collection(COLLECTION_NAME);

    // Find the user by name
    const user = await collection.findOne({ name });
    if (!user) {
      return res.status(401).json({ error: "Invalid name or password" });
    }

    // Check if the provided password matches the stored hash
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: "Invalid name or password" });
    }

    res.status(200).json({ message: "Login successful" });
  } catch (e) {
    console.error("Error in /api/login route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
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

    // Insert the new worker into the collection
    const result = await collection.insertOne({
      usuario,
      registradoPor,
      fecha,
      category,
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

// GET route to fetch all workers
server.get(`/api/workers`, async (req, res) => {
  try {
    const collection = db.collection("workers");

    // Fetch all workers from the collection, sorted by '_id' in descending order
    const workers = await collection.find({}).sort({ _id: -1 }).toArray();

    res.status(200).json(workers);
  } catch (e) {
    console.error("Error in /api/workers route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

// WebSocket setup
const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    // Handle incoming messages if necessary
  });
});

const broadcastTimingUpdate = (timing) => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(timing));
    }
  });
};

const calculateTotalTime = (startTime, endTime) => {
  const duration = (new Date(endTime) - new Date(startTime)) / 1000; // Duration in seconds
  const minutes = Math.floor(duration / 60);
  const hours = Math.floor(minutes / 60);
  return { hours, minutes: minutes % 60 };
};

// POST route to manage timing
server.post(`/api/timing`, async (req, res) => {
  const { usuario, action } = req.body;
  if (!usuario || !action) {
    return res.status(400).json({ error: "Usuario and action are required" });
  }

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
          totalMinutes: 0,
          totalHours: 0,
          createdAt: new Date(),
        };
        await collection.insertOne(newRecord);
        broadcastTimingUpdate(newRecord);
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
          const { hours, minutes } = calculateTotalTime(
            currentRecord.startTime,
            currentRecord.pauseTime
          );
          update = {
            status: "active",
            startTime: new Date(),
            totalHours: currentRecord.totalHours + hours,
            totalMinutes: currentRecord.totalMinutes + minutes,
            pauseTime: null,
          };
        } else if (currentRecord.status === "confirmed") {
          update = {
            status: "active",
            startTime: new Date(),
            pauseTime: null,
            endTime: null,
          };
        } else {
          return res.status(409).json({ error: "Timing is already active" });
        }
        await collection.findOneAndUpdate(
          { _id: currentRecord._id },
          { $set: update }
        );
        timing = { ...currentRecord, ...update };
        break;
      case "pause":
        if (currentRecord.status === "active") {
          update = {
            status: "paused",
            pauseTime: new Date(),
          };
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
          const { hours, minutes } = calculateTotalTime(
            currentRecord.startTime,
            endTime
          );
          update = {
            status: "confirmed",
            endTime: endTime,
            totalHours: currentRecord.totalHours + hours,
            totalMinutes: currentRecord.totalMinutes + minutes,
          };
        } else {
          return res
            .status(409)
            .json({ error: "Timing has already been confirmed" });
        }
        break;
      default:
        return res.status(400).json({ error: "Invalid action" });
    }

    await collection.updateOne({ _id: currentRecord._id }, { $set: update });
    const updatedRecord = await collection.findOne({ _id: currentRecord._id });
    broadcastTimingUpdate(updatedRecord);
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
      };
    });

    res.status(200).json(workersWithTimingStatus);
  } catch (e) {
    console.error("Error in /api/workers/timing route:", e);
    res.status(500).json({ error: "Error connecting to the database" });
  }
});

// Schedule cleanup of times collection every Sunday after payroll
const cleanupTimesCollection = async () => {
  try {
    const timesCollection = db.collection("times");

    await timesCollection.deleteMany({});
    console.log("Times collection cleared after payroll.");
  } catch (e) {
    console.error("Error clearing times collection:", e);
  }
};

// Schedule cleanup at 2:00 AM every Sunday
schedule.scheduleJob("0 2 * * 0", cleanupTimesCollection);

// Start the server
const serverInstance = server.listen(PORT, () => {
  console.log(`Server is running on `);
});

// WebSocket upgrade handling
serverInstance.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});
