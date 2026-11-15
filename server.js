
require("dotenv").config();

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const User = require("./models/User");
const Message = require("./models/Message");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));

// Authentication Middleware
function auth(req, res, next) {
    try {
        const token = req.headers.authorization?.split(" ")[1];

        if (!token) {
            return res.status(401).json({
                error: "Login required"
            });
        }

        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();

    } catch {
        res.status(401).json({
            error: "Invalid token"
        });
    }
}

// Register User
app.post("/api/register", async (req, res) => {
    try {
        const username = String(req.body.username || "")
            .trim().toLowerCase();

        const password = req.body.password;

        if (!/^[a-z0-9_]{3,20}$/.test(username)) {
            return res.status(400).json({
                error: "Username must be 3-20 characters"
            });
        }

        if (typeof password !== "string" ||
            password.length < 8 ||
            password.length > 72) {
            return res.status(400).json({
                error: "Password must contain 8-72 characters"
            });
        }

        const exists = await User.findOne({ username });

        if (exists) {
            return res.status(400).json({
                error: "Username already exists"
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await User.create({
            username,
            password: hashedPassword
        });

        res.status(201).json({
            message: "Registration successful"
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Registration failed"
        });
    }
});

// Login User
app.post("/api/login", async (req, res) => {
    try {
        const username = String(req.body.username || "")
            .trim().toLowerCase();

        const password = req.body.password;

        if (typeof password !== "string") {
            return res.status(400).json({
                error: "Invalid password"
            });
        }

        const user = await User.findOne({ username });

        if (!user || !await bcrypt.compare(password, user.password)) {
            return res.status(401).json({
                error: "Invalid username or password"
            });
        }

        const token = jwt.sign(
            { id: user._id },
            process.env.JWT_SECRET,
            { expiresIn: "1d" }
        );

        res.json({
            token,
            user: {
                _id: user._id,
                username: user.username
            }
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Login failed"
        });
    }
});

// Get Logged-in User Details
app.get("/api/me", auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id)
            .select("username");

        if (!user) {
            return res.status(401).json({
                error: "User not found"
            });
        }

        res.json(user);

    } catch (error) {
        res.status(500).json({
            error: "Unable to get user details"
        });
    }
});

// Get All Users
app.get("/api/users", auth, async (req, res) => {
    try {
        const users = await User.find({
            _id: { $ne: req.user.id }
        }).select("username online");

        res.json(users);

    } catch (error) {
        res.status(500).json({
            error: "Unable to load users"
        });
    }
});

// Get Private Chat History
app.get("/api/messages/:userId", auth, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.userId)) {
            return res.status(400).json({
                error: "Invalid user"
            });
        }

        const otherId = new mongoose.Types.ObjectId(
            req.params.userId
        );

        const myId = new mongoose.Types.ObjectId(
            req.user.id
        );

        const messages = await Message.find({
            $or: [
                { sender: myId, receiver: otherId },
                { sender: otherId, receiver: myId }
            ]
        })
            .sort({ createdAt: 1 })
            .limit(200);

        res.json(messages);

    } catch (error) {
        res.status(500).json({
            error: "Unable to load messages"
        });
    }
});

// Online Users Tracking
const onlineUsers = new Map();

// Socket Authentication
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth.token;

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        socket.userId = decoded.id;
        next();

    } catch {
        next(new Error("Authentication failed"));
    }
});

// Real-Time Private Chat
io.on("connection", async (socket) => {

    const userId = socket.userId;

    socket.join(`user:${userId}`);

    if (!onlineUsers.has(userId)) {
        onlineUsers.set(userId, new Set());
    }

    onlineUsers.get(userId).add(socket.id);

    await User.findByIdAndUpdate(userId, {
        online: true
    });

    io.emit("presence", {
        userId,
        online: true
    });

    // Send Private Message
    socket.on("privateMessage", async (data, callback) => {
        try {
            const receiverId = data?.receiverId;
            const text = data?.text;

            if (!mongoose.isValidObjectId(receiverId) ||
                receiverId === userId) {
                return callback?.({
                    success: false,
                    error: "Invalid receiver"
                });
            }

            if (typeof text !== "string") {
                return callback?.({
                    success: false,
                    error: "Invalid message"
                });
            }

            const message = text.trim();

            if (!message || message.length > 500) {
                return callback?.({
                    success: false,
                    error: "Message must contain 1 to 500 characters"
                });
            }

            const receiver = await User.findById(receiverId);

            if (!receiver) {
                return callback?.({
                    success: false,
                    error: "User not found"
                });
            }

            const savedMessage = await Message.create({
                sender: userId,
                receiver: receiverId,
                message
            });

            // Send message only to sender and receiver
            io.to(`user:${userId}`)
                .to(`user:${receiverId}`)
                .emit("privateMessage", savedMessage);

            callback?.({
                success: true
            });

        } catch (error) {
            console.error(error);

            callback?.({
                success: false,
                error: "Unable to send message"
            });
        }
    });

    // Disconnect User
    socket.on("disconnect", async () => {

        const sockets = onlineUsers.get(userId);

        if (sockets) {
            sockets.delete(socket.id);

            if (sockets.size === 0) {
                onlineUsers.delete(userId);

                await User.findByIdAndUpdate(userId, {
                    online: false
                });

                io.emit("presence", {
                    userId,
                    online: false
                });
            }
        }
    });
});

// Server Health Check
app.get("/health", (req, res) => {
    res.send("ChatConnect Server Running");
});

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(async () => {

        await User.updateMany({}, {
            online: false
        });

        console.log("MongoDB Connected Successfully");

        const PORT = process.env.PORT || 5000;

        server.listen(PORT, "0.0.0.0", () => {
            console.log(`Server running on port ${PORT}`);
        });

    })
    .catch(error => {
        console.error("MongoDB Connection Error:", error);
        process.exit(1);
    });
