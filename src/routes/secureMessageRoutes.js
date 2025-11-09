import dotenv from "dotenv";
dotenv.config();
import { ObjectId } from "mongodb";
import path from "path";

fastify.get("/secure/:id", async (req, reply) => {
  const { id } = req.params;
  const msg = await sent().findOne({ _id: new ObjectId(id) });

  if (!msg) return reply.status(404).send({ error: "Message not found" });
  if (msg.expiresAt && new Date() > new Date(msg.expiresAt))
    return reply.status(410).send({ error: "Message expired" });

  return reply.send({
    encrypted: true,
    hasAttachments: !!msg.attachments?.length,
  });
});

fastify.post("/secure/:id/decrypt", async (req, reply) => {
  const { id } = req.params;
  const { password } = req.body;

  const msg = await sent().findOne({ _id: new ObjectId(id) });
  if (!msg || !msg.encryptedData)
    return reply.status(404).send({ error: "Message not found" });

  try {
    const decryptedBody = decryptText(msg.encryptedData, password);

    // Decrypt attachments
    const decryptedAttachments = [];
    for (const enc of msg.attachments || []) {
      const decryptedPath = enc.encPath.replace(/\.enc$/, "");
      decryptFile(enc.encPath, password, enc.iv, decryptedPath);
      decryptedAttachments.push({
        name: enc.name,
        mimeType: enc.mimeType,
        url: `/uploads/${path.basename(decryptedPath)}`,
      });
    }

    return reply.send({
      success: true,
      body: decryptedBody,
      attachments: decryptedAttachments,
    });
  } catch (err) {
    return reply.status(400).send({ error: "Invalid password" });
  }
});
