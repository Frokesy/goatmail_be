import Fastify from "fastify";
import connectDB from "./db.js";
import authRoutes from "./routes/authRoutes.js";
import dotenv from "dotenv";

dotenv.config();

const fastify = Fastify({
    logger: true,
});

fastify.register(connectDB);
fastify.register(authRoutes);

try {
    await fastify.listen({ port: 3000 });
} catch (error) {
    fastify.log.error(error);
    process.exit(1);
}