import dotenv from "dotenv";
dotenv.config();
import Fastify from "fastify";
import fastifyMongodb from "@fastify/mongodb";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import authPlugin from "./plugins/auth.js";

const fastify = Fastify({ logger: true });

fastify.register(fastifyMongodb, {
    forceClose: true,
    url: process.env.MONGO_URI,
});

fastify.register(authPlugin);
fastify.register(authRoutes, { prefix: "/api/auth" });
fastify.register(userRoutes, { prefix: "/api" });

fastify.listen({ port: 3000, host: "0.0.0.0" }, (err, address) => {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    console.log(`Server listening at ${address}`);
});