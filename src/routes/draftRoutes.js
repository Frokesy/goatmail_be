import { ObjectId } from "mongodb";

const draftRoutes = (fastify, opts, done) => {
    const users = () => fastify.mongo.db.collection("users");

    fastify.post(
        "/save-draft", { preHandler: [fastify.authenticate] },
        async(req, reply) => {
            try {
                const { draftId, to, cc, bcc, subject, body } = req.body;
                const userEmail = req.user.email;

                const draft = {
                    to,
                    cc,
                    bcc,
                    subject,
                    body,
                    updatedAt: new Date(),
                };

                let id;

                if (draftId) {
                    const objId = new ObjectId(draftId);
                    await users().updateOne({ email: userEmail, "drafts._id": objId }, {
                        $set: {
                            "drafts.$": {
                                ...draft,
                                _id: objId,
                                createdAt: new Date(),
                            },
                        },
                    });
                    id = objId.toString();
                } else {
                    // create new draft
                    const newId = new ObjectId();
                    await users().updateOne({ email: userEmail }, {
                        $push: {
                            drafts: {
                                ...draft,
                                _id: newId,
                                createdAt: new Date(),
                            },
                        },
                    });
                    id = newId.toString();
                }

                return reply.send({ success: true, draftId: id });
            } catch (err) {
                fastify.log.error("Save draft error:", err);
                return reply.status(500).send({ error: err.message });
            }
        }
    );

    fastify.delete(
        "/drafts/:id", { preHandler: [fastify.authenticate] },
        async(req, reply) => {
            try {
                await users().updateOne({ email: req.user.email }, { $pull: { drafts: { _id: new ObjectId(req.params.id) } } });

                return reply.send({ success: true });
            } catch (err) {
                return reply.status(500).send({ error: err.message });
            }
        }
    );

    fastify.get(
        "/drafts", { preHandler: [fastify.authenticate] },
        async(req, reply) => {
            try {
                const userDoc = await users().findOne({ email: req.user.email }, { projection: { drafts: 1 } });

                return reply.send({ drafts: userDoc.drafts || [] });
            } catch (err) {
                return reply.status(500).send({ error: err.message });
            }
        }
    );

    done();
};

export default draftRoutes;