import dotenv from "dotenv";
dotenv.config();
import Fastify from "fastify";
import fastifyMongodb from "@fastify/mongodb";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import authPlugin from "./plugins/auth.js";
import inboxRoutes from "./routes/inboxRoutes.js";
import incomingServerRoutes from "./routes/incomingServerRoutes.js";
import sendMailRoutes from "./routes/sendMailRoutes.js";
import draftRoutes from "./routes/draftRoutes.js";
import scheduleEmailRoutes from "./routes/scheduleEmailRoute.js";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import aiRoutes from "./routes/ai.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fastify = Fastify({ logger: true });

fastify.register(fastifyMongodb, {
  forceClose: true,
  url: process.env.MONGO_URI,
});

fastify.register(fastifyMultipart, {
  limits: { fileSize: 25 * 1024 * 1024 },
});

fastify.register(fastifyStatic, {
  root: join(__dirname, "routes/uploads"),
  prefix: "/uploads/",
});

fastify.register(authPlugin);
fastify.register(authRoutes, { prefix: "/api/auth" });
fastify.register(userRoutes, { prefix: "/api" });
fastify.register(inboxRoutes, { prefix: "/api" });
fastify.register(incomingServerRoutes, { prefix: "/api" });
fastify.register(sendMailRoutes, { prefix: "/api" });
fastify.register(scheduleEmailRoutes, { prefix: "/api" });
fastify.register(draftRoutes, { prefix: "/api" });
fastify.register(aiRoutes, { prefix: "/api" });

fastify.listen({ port: 3000, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`Server listening at ${address}`);
});
