import "dotenv/config"; // must be first: later imports read env at load time

import http from "http";
import app from "./app";
import { initSocketIO } from "./realtime/socket";
import { startEventForwarder } from "./realtime/events";
import { jwtSecret } from "./config/env";

jwtSecret(); // fail fast if JWT_SECRET is missing

const port = Number(process.env.PORT) || 8081;

const server = http.createServer(app);
initSocketIO(server);
startEventForwarder();

server.listen(port, () => {
  console.log(`🚀 CertiFlow Server is running on port ${port}`);
  console.log(`🔗 http://localhost:${port}`);
});

export default server;