import Fastify from "fastify";
import connectDB from "./db.js";

const fastify = Fastify({
    logger: true,
});

fastify.register(connectDB);

try {
    await fastify.listen({ port: 3000 });
} catch (error) {
    fastify.log.error(error);
    process.exit(1);
}