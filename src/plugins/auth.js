import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";

async function authPlugin(fastify, opts) {
    fastify.register(fastifyJwt, {
        secret: process.env.JWT_SECRET,
    });

    fastify.decorate("authenticate", async function(request, reply) {
        try {
            await request.jwtVerify();
        } catch (err) {
            reply.send(err);
        }
    });
}

export default fp(authPlugin);