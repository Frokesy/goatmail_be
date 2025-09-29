export default async function incomingServerRoutes(fastify) {
    fastify.get(
        "/incoming-server", { preValidation: [fastify.authenticate] },
        async(req, reply) => {
            try {
                const user = req.user;

                const foundUser = await fastify.mongo.db
                    .collection("users")
                    .findOne({ email: user.email });

                if (!foundUser || !foundUser.incomingServer) {
                    return reply
                        .code(404)
                        .send({ message: "Incoming server configuration not found" });
                }

                const config = foundUser.incomingServer;

                return reply.send({
                    email: config.email,
                    serverType: config.serverType,
                    serverName: config.serverName,
                    password: decrypt(config.password),
                    port: config.port,
                    security: config.security,
                });
            } catch (err) {
                req.log.error(err);
                return reply
                    .code(500)
                    .send({ message: "Failed to fetch incoming server configuration" });
            }
        }
    );
}