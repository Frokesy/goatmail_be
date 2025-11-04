import { ObjectId } from "mongodb";
import { decrypt } from "../utils/cryptoUtils.js";
import SMTPConnection from "smtp-connection";
import cron from "node-cron";

const scheduleEmailRoutes = (fastify, opts, done) => {
  const users = () => fastify.mongo.db.collection("users");
  const scheduled = () => fastify.mongo.db.collection("scheduledEmails");
  const sent = () => fastify.mongo.db.collection("sentEmails");

  fastify.post(
    "/schedule-email",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const {
          to,
          cc,
          bcc,
          subject,
          body,
          name,
          scheduledAt,
          track = false,
        } = req.body;

        if (!to || !subject || !body || !scheduledAt)
          return reply.status(400).send({ error: "Missing required fields" });

        const scheduleDate = new Date(scheduledAt);
        if (isNaN(scheduleDate.getTime()))
          return reply.status(400).send({ error: "Invalid date format" });

        const user = await users().findOne({ email: req.user.email });
        if (!user?.outgoingEmail)
          return reply.status(404).send({ error: "SMTP not configured" });

        const doc = {
          userId: user._id,
          to,
          cc,
          bcc,
          subject,
          body,
          name,
          track,
          scheduledAt: scheduleDate,
          status: "pending",
          createdAt: new Date(),
        };

        await scheduled().insertOne(doc);
        reply.send({ success: true, message: "Email scheduled successfully" });
      } catch (err) {
        console.error("Schedule email error:", err);
        reply.status(500).send({ error: err.message });
      }
    }
  );

  cron.schedule("* * * * *", async () => {
    const now = new Date();

    const dueEmails = await scheduled()
      .find({ scheduledAt: { $lte: now }, status: "pending" })
      .toArray();

    for (const email of dueEmails) {
      try {
        const userDoc = await users().findOne({
          _id: new ObjectId(email.userId),
        });
        if (!userDoc || !userDoc.outgoingEmail) continue;

        const out = userDoc.outgoingEmail;
        const plainPass = decrypt(out.password);

        let finalBody = email.body;
        let trackingId;
        if (email.track) {
          trackingId = new ObjectId().toString();
          const pixelUrl = `${process.env.API_URL}/tracking/open/${trackingId}`;
          const trackingPixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" />`;

          finalBody += `\n\n${trackingPixel}`;

          // Wrap links for click tracking
          finalBody = finalBody.replace(
            /(https?:\/\/[^\s]+)/g,
            (url) =>
              `${
                process.env.API_URL
              }/tracking/click/${trackingId}?redirect=${encodeURIComponent(
                url
              )}`
          );
        }

        const connection = new SMTPConnection({
          host: out.smtpServer,
          port: Number(out.port),
          secure:
            (out.securityType || "").toUpperCase().includes("SSL") ||
            Number(out.port) === 465,
          tls: { rejectUnauthorized: false },
        });

        await new Promise((res, rej) =>
          connection.connect((err) => (err ? rej(err) : res()))
        );
        await new Promise((res, rej) =>
          connection.login({ user: out.email, pass: plainPass }, (err) =>
            err ? rej(err) : res()
          )
        );

        const senderName = email.name || out.email.split("@")[0];
        const fromHeader = `"${senderName}" <${out.email}>`;

        const recipients = []
          .concat(email.to || [])
          .concat(email.cc || [])
          .concat(email.bcc || [])
          .filter(Boolean);

        const message = `From: ${fromHeader}
To: ${Array.isArray(email.to) ? email.to.join(", ") : email.to}
${
  email.cc
    ? `Cc: ${Array.isArray(email.cc) ? email.cc.join(", ") : email.cc}\n`
    : ""
}Subject: ${email.subject}
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: 7bit

<html>
  <body>
    ${finalBody}
  </body>
</html>
`;

        const info = await new Promise((res, rej) =>
          connection.send(
            { from: out.email, to: recipients },
            message,
            (err, i) => (err ? rej(err) : res(i))
          )
        );

        connection.quit();

        const emailDoc = {
          ...email,
          sentAt: new Date(),
          smtpInfo: info,
        };

        if (email.track) {
          emailDoc.trackingId = trackingId;
          emailDoc.opened = false;
          emailDoc.clicks = [];
        }

        await sent().insertOne(emailDoc);

        await scheduled().updateOne(
          { _id: email._id },
          { $set: { status: "sent", sentAt: new Date() } }
        );

        console.log(`✅ Sent scheduled email: ${email.subject}`);
      } catch (err) {
        console.error("Failed to send scheduled email:", err);
        await scheduled().updateOne(
          { _id: email._id },
          { $set: { status: "failed", error: err.message } }
        );
      }
    }
  });

  done();
};

export default scheduleEmailRoutes;
