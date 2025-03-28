const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = 3000;

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  socket.on('robot-video', (frame) => {
    socket.broadcast.emit('video-stream', frame);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
