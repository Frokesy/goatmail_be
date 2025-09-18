import fastifyPlugin from "fastify-plugin";
import fastifyMongodb from "@fastify/mongodb";
import dotenv from "dotenv";

dotenv.config();

const connectDB = async(fastify, options) => {
    fastify.register(fastifyMongodb, {
        forceClose: true,
        url: process.env.MONGO_URI || "mongodb://localhost:27017/goatmail",
    });
};

export default fastifyPlugin(connectDB);