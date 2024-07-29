// server/mongodb.js
const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("Missing MONGODB_URI environment variable");
}

let client;
let clientPromise;

if (!global._mongoClientPromise) {
  client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  global._mongoClientPromise = client.connect().catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1); // Exit process if there's an error
  });
}

clientPromise = global._mongoClientPromise;

module.exports = clientPromise;
