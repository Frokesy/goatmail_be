import Fastify from "fastify";
import fastifyMongodb from "@fastify/mongodb";
import authRoutes from "./routes/authRoutes.js";
import dotenv from "dotenv";

dotenv.config();

const fastify = Fastify({ logger: true });

fastify.register(fastifyMongodb, {
    forceClose: true,
    url: process.env.MONGO_URI,
});

fastify.register(authRoutes, { prefix: "/api/auth" });

fastify.listen({ port: 3000, host: "0.0.0.0" }, (err, address) => {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    console.log(`Server listening at ${address}`);
});