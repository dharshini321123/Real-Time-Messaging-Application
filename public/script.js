
let token = "";
let currentUser = null;
let selectedUser = null;
let socket = null;
let users = [];
let unread = {};

const authPage = document.getElementById("authPage");
const dashboard = document.getElementById("dashboard");
const contacts = document.getElementById("contacts");
const messages = document.getElementById("messages");

let mode = "login";

// API helper
async function api(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...options.headers
        }
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || "Request failed");
    }

    return data;
}

// Login and Register tabs
document.getElementById("loginTab").onclick = () => setMode("login");

document.getElementById("registerTab").onclick = () => setMode("register");

function setMode(value) {
    mode = value;

    document.getElementById("loginTab").classList.toggle(
        "active", mode === "login"
    );

    document.getElementById("registerTab").classList.toggle(
        "active", mode === "register"
    );

    document.getElementById("authButton").textContent =
        mode === "login" ? "Login" : "Register";

    document.getElementById("authStatus").textContent = "";
}

// Login / Register form
document.getElementById("authForm").onsubmit = async (event) => {
    event.preventDefault();

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    try {
        const result = await api(`/api/${mode}`, {
            method: "POST",
            body: JSON.stringify({ username, password })
        });

        if (mode === "register") {
            alert("Registration successful! Please login.");
            setMode("login");
            return;
        }

        token = result.token;
        currentUser = result.user;

        localStorage.setItem("chatToken", token);

        openDashboard();

    } catch (error) {
        document.getElementById("authStatus").textContent =
            error.message;
    }
};

// Dashboard
async function openDashboard() {
    authPage.hidden = true;
    dashboard.hidden = false;

    document.getElementById("myUsername").textContent =
        "@" + currentUser.username;

    connectSocket();
    await loadUsers();
}

// Connect Socket.IO
function connectSocket() {
    if (socket) socket.disconnect();

    socket = io({
        auth: { token }
    });

    socket.on("connect_error", () => {
        document.getElementById("messageStatus").textContent =
            "Connection failed. Please login again.";
    });

    socket.on("presence", data => {
        const user = users.find(u => u._id === data.userId);

        if (user) {
            user.online = data.online;
            renderUsers();
            updateChatStatus();
        }
    });

    socket.on("privateMessage", data => {
        const otherId = String(data.sender) === currentUser._id
            ? String(data.receiver)
            : String(data.sender);

        if (selectedUser &&
            selectedUser._id === otherId) {
            displayMessage(data);
        } else {
            unread[otherId] = (unread[otherId] || 0) + 1;
            renderUsers();
        }
    });
}

// Load users
async function loadUsers() {
    try {
        users = await api("/api/users");
        renderUsers();
    } catch (error) {
        alert(error.message);
    }
}

// Display contacts
function renderUsers() {
    const search = document.getElementById("searchUser")
        .value.toLowerCase();

    contacts.innerHTML = "";

    users
        .filter(user => user.username.includes(search))
        .forEach(user => {
            const div = document.createElement("div");
            div.className = "contact";

            if (selectedUser &&
                selectedUser._id === user._id) {
                div.classList.add("selected");
            }

            const name = document.createElement("strong");
            name.textContent = user.username;

            const status = document.createElement("small");
            status.textContent = user.online
                ? " ● Online"
                : " ○ Offline";

            status.className = user.online
                ? "online-dot"
                : "offline-dot";

            const count = unread[user._id] || 0;

            div.append(name, document.createElement("br"), status);

            if (count > 0) {
                const badge = document.createElement("small");
                badge.textContent = ` (${count} new)`;
                div.appendChild(badge);
            }

            div.onclick = () => openChat(user);

            contacts.appendChild(div);
        });
}

document.getElementById("searchUser").oninput = renderUsers;

// Open private chat
async function openChat(user) {
    selectedUser = user;
    unread[user._id] = 0;

    document.getElementById("welcomeScreen").hidden = true;
    document.getElementById("conversation").hidden = false;

    document.getElementById("contactName").textContent =
        user.username;

    updateChatStatus();
    renderUsers();

    messages.innerHTML = "";

    try {
        const history = await api(`/api/messages/${user._id}`);

        history.forEach(displayMessage);

    } catch (error) {
        document.getElementById("messageStatus").textContent =
            error.message;
    }
}

// Update online status
function updateChatStatus() {
    if (!selectedUser) return;

    document.getElementById("contactStatus").textContent =
        selectedUser.online ? "● Online" : "○ Offline";
}

// Display message safely
function displayMessage(data) {
    const div = document.createElement("div");

    const isSent = String(data.sender) === currentUser._id;

    div.className = "message " +
        (isSent ? "sent" : "received");

    const text = document.createElement("div");
    text.textContent = data.message;

    const time = document.createElement("small");
    time.textContent =
        new Date(data.createdAt).toLocaleTimeString();

    div.append(text, time);
    messages.appendChild(div);

    messages.scrollTop = messages.scrollHeight;
}

// Send private message
document.getElementById("messageForm")
    .onsubmit = (event) => {

        event.preventDefault();

        if (!selectedUser) return;

        const input = document.getElementById("messageInput");
        const message = input.value.trim();

        const status = document.getElementById("messageStatus");

        if (!message || message.length > 500) {
            status.textContent = "Enter a valid message";
            return;
        }

        if (!socket || !socket.connected) {
            status.textContent = "Connection unavailable";
            return;
        }

        socket.emit("privateMessage", {
            receiverId: selectedUser._id,
            text: message
        }, result => {

            if (result.success) {
                input.value = "";
                status.textContent = "";
            } else {
                status.textContent = result.error;
            }
        });
    };

// Logout
document.getElementById("logoutButton").onclick = () => {
    if (socket) {
        socket.disconnect();
        socket = null;
    }

    localStorage.removeItem("chatToken");

    token = "";
    currentUser = null;
    selectedUser = null;
    users = [];
    unread = {};

    dashboard.hidden = true;
    authPage.hidden = false;

    document.getElementById("authForm").reset();
    document.getElementById("authStatus").textContent = "";
};

// Restore login after refresh
async function restoreLogin() {
    const savedToken = localStorage.getItem("chatToken");

    if (!savedToken) return;

    token = savedToken;

    try {
        const result = await api("/api/users");

        // Validate the saved token and get current user
        const payload = JSON.parse(
            atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))
        );

        const response = await fetch("/api/me", {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (!response.ok) throw new Error("Login expired");

        currentUser = await response.json();
        openDashboard();

    } catch {
        localStorage.removeItem("chatToken");
        token = "";
    }
}

restoreLogin();
