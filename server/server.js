const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new socketIo.Server(server, {
  connectionStateRecovery: {
    //2 minutes for reconnection to the same session
    maxDisconnectionDuration: 2*60*1000,
    skipMiddlewares: true
  }
})

app.use(express.static(__dirname + '/../client'));

io.on('connection', (socket) => {
  console.log(`Client connected\n  sessionId: ${socket.id}`);
  socket.on('message', (data) => {
    console.log('Received message:', data);
    socket.broadcast.emit('message', data);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
