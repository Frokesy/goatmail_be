const userRoutes = (fastify, opts) => {
    const users = () => fastify.mongo.db.collection("users");
    fastify.get(
        "/get-user", { preHandler: [fastify.authenticate] },
        async(req, reply) => {
            try {
                const email = req.user.email;
                const user = await users().findOne({ email }, { projection: { password: 0 } });
                if (!user) return reply.status(404).send({ message: "User not found" });

                return { user };
            } catch (err) {
                reply.status(500).send({ error: err.message });
            }
        }
    );
};

export default userRoutes;