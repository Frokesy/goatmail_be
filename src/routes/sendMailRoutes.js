import SMTPConnection from "smtp-connection";
import { decrypt } from "../utils/cryptoUtils.js";

const sendMailRoutes = (fastify, opts, done) => {
        const users = () => fastify.mongo.db.collection("users");
        const sent = () => fastify.mongo.db.collection("sentEmails");

        fastify.post(
                "/send-email", { preHandler: [fastify.authenticate] },
                async(req, reply) => {
                    try {
                        const { to, cc, bcc, subject, body, name } = req.body;

                        if (!to || !subject || !body) {
                            return reply.status(400).send({ error: "Missing required fields" });
                        }

                        const userDoc = await users().findOne({ email: req.user.email }, {
                            projection: {
                                "outgoingEmail.password": 1,
                                "outgoingEmail.smtpServer": 1,
                                "outgoingEmail.securityType": 1,
                                "outgoingEmail.port": 1,
                                "outgoingEmail.email": 1,
                            },
                        });

                        if (!userDoc || !userDoc.outgoingEmail)
                            return reply
                                .status(404)
                                .send({ message: "SMTP details not configured" });

                        const out = userDoc.outgoingEmail;
                        if (!out.password || typeof out.password !== "object")
                            return reply.status(400).send({
                                message: "Password not stored in reversible form. User must re-enter password.",
                            });

                        const plainPass = decrypt(out.password);

                        // Create SMTP connection (credentials will be passed at login step)
                        const connection = new SMTPConnection({
                            host: out.smtpServer,
                            port: Number(out.port),
                            secure:
                                (out.securityType || "").toUpperCase().includes("SSL") ||
                                Number(out.port) === 465, // SSL usually 465
                            tls: { rejectUnauthorized: false },
                        });

                        // Helpers
                        const connectPromise = () =>
                            new Promise((resolve, reject) => {
                                connection.connect((err) => {
                                    if (err) reject(err);
                                    else resolve(true);
                                });
                            });

                        const loginPromise = () =>
                            new Promise((resolve, reject) => {
                                connection.login({ user: out.email, pass: "vqxfsxjuqhsyiujr" || plainPass },
                                    (err) => {
                                        if (err) reject(err);
                                        else resolve(true);
                                    }
                                );
                            });

                        const sendPromise = () =>
                            new Promise((resolve, reject) => {
                                    const senderName = name || out.email.split("@")[0];
                                    const fromHeader = `"${senderName}" <${out.email}>`;

                                    const recipients = []
                                        .concat(to || [])
                                        .concat(cc || [])
                                        .concat(bcc || [])
                                        .filter(Boolean);

                                    const message = `From: ${fromHeader}
To: ${Array.isArray(to) ? to.join(", ") : to}
${
  cc ? `Cc: ${Array.isArray(cc) ? cc.join(", ") : cc}\n` : ""
}Subject: ${subject}

${body}
`;

            connection.send(
              { from: out.email, to: recipients },
              message,
              (err, info) => {
                if (err) reject(err);
                else resolve(info);
              }
            );
          });

        const quitPromise = () =>
          new Promise((resolve) => {
            connection.quit();
            resolve(true);
          });

        // Flow
        await connectPromise();
        await loginPromise();
        const info = await sendPromise();
        await quitPromise();

        // Save sent email to DB
        await sent().insertOne({
          userId: userDoc._id,
          from: out.email,
          to,
          cc,
          bcc,
          subject,
          body,
          sentAt: new Date(),
          smtpInfo: info,
        });

        return reply.send({ success: true, info });
      } catch (err) {
        console.error("SMTP Error:", err);
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  done();
};

export default sendMailRoutes;