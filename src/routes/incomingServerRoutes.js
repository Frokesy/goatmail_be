import { decrypt, encrypt } from "../utils/cryptoUtils.js";

export default async function incomingServerRoutes(fastify) {
  fastify.get(
    "/incoming-server",
    { preValidation: [fastify.authenticate] },
    async (req, reply) => {
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

  fastify.put(
    "/update-incoming-password",
    { preValidation: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const { email, serverType, serverName, password, port, security } =
          req.body;

        if (!email) {
          return reply.code(400).send({ error: "Email is required" });
        }

        const user = await fastify.mongo.db
          .collection("users")
          .findOne({ email });
        if (!user) {
          return reply.code(404).send({ error: "User not found" });
        }

        const updateFields = {};

        if (serverType) updateFields["incomingServer.serverType"] = serverType;
        if (serverName) updateFields["incomingServer.serverName"] = serverName;
        if (port) updateFields["incomingServer.port"] = port;
        if (security) updateFields["incomingServer.security"] = security;
        if (password)
          updateFields["incomingServer.password"] = encrypt(password);

        if (Object.keys(updateFields).length === 0) {
          return reply
            .code(400)
            .send({ error: "No fields provided to update" });
        }

        await fastify.mongo.db
          .collection("users")
          .updateOne({ email }, { $set: updateFields });

        return reply.code(200).send({
          message: "Incoming server password updated successfully",
          updatedFields: Object.keys(updateFields),
        });
      } catch (err) {
        req.log.error(err);
        return reply
          .code(500)
          .send({ error: "Failed to update incoming server password" });
      }
    }
  );
}
