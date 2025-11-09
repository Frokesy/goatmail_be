import dotenv from "dotenv";
dotenv.config();
import SMTPConnection from "smtp-connection";
import { decrypt } from "../utils/cryptoUtils.js";
import { ObjectId } from "mongodb";
import fs from "fs";
import path from "path";
import { pipeline } from "stream";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { encryptFile, encryptText } from "../utils/emailEncryption.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pump = promisify(pipeline);

const sendMailRoutes = (fastify, opts, done) => {
  const users = () => fastify.mongo.db.collection("users");
  const sent = () => fastify.mongo.db.collection("sentEmails");

  fastify.post("/upload-attachment", async (req, reply) => {
    const data = await req.file();
    const cleanFileName = decodeURIComponent(data.filename);
    const safeFileName = cleanFileName.replace(/[^\w.\- ()]/g, "");
    const fileName = Date.now() + "-" + safeFileName;
    const uploadDir = path.join(__dirname, "uploads");

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = path.join(uploadDir, fileName);
    await pump(data.file, fs.createWriteStream(filePath));

    return {
      success: true,
      file: {
        name: data.filename,
        url: `/uploads/${fileName}`,
        size: data.file.bytesRead,
        mimeType: data.mimetype,
      },
    };
  });
  fastify.post(
    "/send-email",
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
          track = false,
          attachments = [],
          encrypt = false,
          password,
          expiresAt,
        } = req.body;

        if (!to || !subject || !body) {
          return reply.status(400).send({ error: "Missing required fields" });
        }
        const secureId = new ObjectId().toString();

        const userDoc = await users().findOne(
          { email: req.user.email },
          {
            projection: {
              "outgoingEmail.password": 1,
              "outgoingEmail.smtpServer": 1,
              "outgoingEmail.securityType": 1,
              "outgoingEmail.port": 1,
              "outgoingEmail.email": 1,
            },
          }
        );

        if (!userDoc || !userDoc.outgoingEmail) {
          return reply
            .status(404)
            .send({ message: "SMTP details not configured" });
        }

        const out = userDoc.outgoingEmail;
        const plainPass = decrypt(out.password);

        let finalBody = body;
        let encryptedData;
        let encryptedAttachments = [];

        if (encrypt && password) {
          const encrypted = encryptText(body, password);
          encryptedData = encrypted;

          for (const att of attachments) {
            const decodedFileName = decodeURIComponent(path.basename(att.url));
            const filePath = path.join(__dirname, "uploads", decodedFileName);

            if (fs.existsSync(filePath)) {
              const encryptedFile = encryptFile(filePath, password);

              encryptedAttachments.push({
                name: att.name,
                mimeType: att.mimeType,
                iv: encryptedFile.iv,
                encPath: encryptedFile.path,
                originalName: att.name,
              });
            }
          }

          const secureLink = `${process.env.APP_URL}/secure/${secureId}`;
          finalBody = `
    <p>This email is protected.</p>
    <p>Click below to view it securely:</p>
    <a href="${secureLink}">${secureLink}</a>
    <br><br>
    <small>You'll need the password to open it.</small>
  `;

          attachments.length = 0;
        }

        let trackingId;
        if (track) {
          trackingId = new ObjectId().toString();
          const pixelUrl = `${process.env.API_URL}/tracking/open/${trackingId}`;
          const trackingPixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" />`;

          finalBody += `\n\n${trackingPixel}`;

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

        const connectPromise = () =>
          new Promise((resolve, reject) => {
            connection.connect((err) => (err ? reject(err) : resolve(true)));
          });
        const loginPromise = () =>
          new Promise((resolve, reject) => {
            connection.login({ user: out.email, pass: plainPass }, (err) =>
              err ? reject(err) : resolve(true)
            );
          });

        const boundary = `----=_Part_${Date.now()}`;
        const senderName = name || out.email.split("@")[0];
        const fromHeader = `"${senderName}" <${out.email}>`;

        const recipients = []
          .concat(to || [])
          .concat(cc || [])
          .concat(bcc || [])
          .filter(Boolean);

        let message = [
          `From: ${fromHeader}`,
          `To: ${Array.isArray(to) ? to.join(", ") : to}`,
          cc ? `Cc: ${Array.isArray(cc) ? cc.join(", ") : cc}` : null,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          ``,
          `--${boundary}`,
          `Content-Type: text/html; charset="UTF-8"`,
          `Content-Transfer-Encoding: quoted-printable`,
          ``,
          `${finalBody}`,
        ]
          .filter(Boolean)
          .join("\r\n");

        for (const att of attachments) {
          const decodedFileName = decodeURIComponent(path.basename(att.url));
          const filePath = path.join(__dirname, "uploads", decodedFileName);

          if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath).toString("base64");

            message += [
              ``,
              `--${boundary}`,
              `Content-Type: ${
                att.mimeType || "application/octet-stream"
              }; name="${att.name}"`,
              `Content-Disposition: attachment; filename="${att.name}"`,
              `Content-Transfer-Encoding: base64`,
              ``,
              fileContent,
            ].join("\r\n");
          }
        }
        message += `\r\n--${boundary}--\r\n`;

        const sendPromise = () =>
          new Promise((resolve, reject) => {
            connection.send(
              { from: out.email, to: recipients },
              message,
              (err, info) => (err ? reject(err) : resolve(info))
            );
          });

        await connectPromise();
        await loginPromise();
        const info = await sendPromise();
        connection.quit();

        await sent().insertOne({
          _id: secureId ? new ObjectId(secureId) : new ObjectId(),
          userId: userDoc._id,
          from: out.email,
          senderName: name,
          to,
          cc,
          bcc,
          subject,
          ...(encrypt
            ? {
                encrypted: true,
                encryptedData,
                attachments: encryptedAttachments,
                expiresAt: expiresAt ? new Date(expiresAt) : null,
              }
            : { body, attachments }),
          sentAt: new Date(),
          smtpInfo: info,
          ...(track && { trackingId, opened: false, clicks: [] }),
        });

        return reply.send({ success: true, info });
      } catch (err) {
        console.error("Send Email Error:", err);
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  fastify.get(
    "/sent-emails",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const userId = req.user.userId;

        const emails = await sent()
          .find({ userId: new ObjectId(userId) })
          .sort({ _id: -1 })
          .toArray();

        return reply.send({ emails });
      } catch (err) {
        console.error("Fetch Sent Emails Error:", err);
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  fastify.get(
    "/sent-emails/:id",
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      try {
        const userId = req.user.userId;
        const emailId = req.params.id;

        if (!ObjectId.isValid(emailId)) {
          return reply.status(400).send({ error: "Invalid email ID" });
        }

        const email = await sent().findOne({
          _id: new ObjectId(emailId),
          userId: new ObjectId(userId),
        });

        if (!email) {
          return reply.status(404).send({ error: "Email not found" });
        }
        return reply.send({ email });
      } catch (err) {
        console.error("Fetch Single Sent Email Error:", err);
        return reply.status(500).send({ error: err.message });
      }
    }
  );

  fastify.get("/tracking/open/:id", async (req, reply) => {
    const { id } = req.params;

    await sent().updateOne(
      { trackingId: id },
      {
        $set: { opened: true },
        $push: {
          openEvents: {
            time: new Date(),
            ip: req.ip,
            ua: req.headers["user-agent"],
          },
        },
      }
    );

    reply
      .header(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate"
      )
      .header("Pragma", "no-cache")
      .header("Expires", "0")
      .header("Surrogate-Control", "no-store");

    const pixel = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      "base64"
    );
    reply.header("Content-Type", "image/gif").send(pixel);
  });

  fastify.get("/tracking/click/:id", async (req, reply) => {
    const { id } = req.params;
    const { redirect } = req.query;
    await sent().updateOne(
      { trackingId: id },
      { $push: { clicks: { url: redirect, time: new Date() } } }
    );
    reply.redirect(redirect);
  });

  done();
};

export default sendMailRoutes;
