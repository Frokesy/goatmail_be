import dotenv from "dotenv";
import { createRequire } from "module";

dotenv.config();

const require = createRequire(
    import.meta.url);
const { sendOtpEmail } = require("../utils/email/sendOtp.js");
import bcrypt from "bcrypt";
import speakeasy from "speakeasy";
import QRCode from "qrcode";
import jwt from "jsonwebtoken";

const authRoutes = async(fastify, options) => {
    const users = () => fastify.mongo.db.collection("users");
    const plansCollection = fastify.mongo.db.collection("plans");

    fastify.post("/signup", async(req, rep) => {
        const { email } = req.body;

        const existingUser = await users().findOne({ email });
        if (existingUser) return rep.code(400).send({ error: "User exists" });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        await users().insertOne({
            email,
            otp,
            verified: false,
            createdAt: new Date(),
        });

        try {
            await sendOtpEmail(email, otp);
        } catch (err) {
            console.error("Error sending OTP:", err);
            return rep.code(500).send({ error: "Failed to send OTP" });
        }

        return rep.code(200).send({ message: "OTP sent", otp });
    });

    fastify.post("/resend-otp", async(req, reply) => {
        const { email } = req.body;
        if (!email) return reply.code(400).send({ error: "Email is required" });

        const user = await users().findOne({ email });
        if (!user) return reply.code(404).send({ error: "User not found" });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await users().updateOne({ email }, { $set: { otp, verified: false } });

        try {
            await sendOtpEmail(email, otp);
        } catch (err) {
            console.error("Error sending OTP:", err);
            return reply.code(500).send({ error: "Failed to send OTP" });
        }

        return reply.code(200).send({ message: "OTP resent", otp });
    });

    fastify.post("/verify-otp", async(req, rep) => {
        const { email, otp } = req.body;
        const user = await users().findOne({ email });

        if (!user || user.otp !== otp) {
            return rep.code(400).send({ error: "Invalid OTP" });
        }

        await users().updateOne({ email }, { $set: { verified: true }, $unset: { otp: "" } });

        return rep.code(200).send({ message: "Email verified" });
    });

    fastify.post("/set-password", async(req, reply) => {
        const { email, password } = req.body;
        const user = await users().findOne({ email });

        if (!user || !user.verified) {
            return reply.code(400).send({ error: "Email not verified" });
        }

        const hashed = await bcrypt.hash(password, 10);
        await users().updateOne({ email }, { $set: { password: hashed } });

        return { message: "Password set successfully" };
    });

    fastify.post("/set-incoming-server", async(req, reply) => {
        const { email, serverType, serverName, password, port, security } =
        req.body;

        if (!email ||
            !serverType ||
            !serverName ||
            !password ||
            !port ||
            !security
        ) {
            return reply.code(400).send({ error: "All fields are required" });
        }

        const user = await users().findOne({ email });
        if (!user) return reply.code(404).send({ error: "User not found" });

        const hashedPassword = await bcrypt.hash(password, 10);

        await users().updateOne({ email }, {
            $set: {
                incomingServer: {
                    serverType,
                    serverName,
                    password: hashedPassword,
                    port,
                    security,
                },
            },
        });

        return reply
            .code(200)
            .send({ message: "Incoming server saved successfully" });
    });

    fastify.post("/set-outgoing-server", async(req, reply) => {
        const { email, smtpServer, password, port, securityType } = req.body;

        if (!email) return reply.code(400).send({ error: "Email is required" });

        const user = await users().findOne({ email });

        if (!user || !user.verified) {
            return reply.code(400).send({ error: "Email not verified" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await users().updateOne({ email }, {
            $set: {
                outgoingEmail: {
                    smtpServer,
                    password: hashedPassword,
                    port,
                    securityType,
                },
            },
        });

        return { message: "Outgoing email server saved successfully" };
    });

    fastify.get("/2fa/setup", async(req, reply) => {
        const { email } = req.query;
        if (!email) return reply.code(400).send({ error: "Email is required" });

        const user = await users().findOne({ email });
        if (!user) return reply.code(404).send({ error: "User not found" });

        const secret = speakeasy.generateSecret({ length: 20 });

        await users().updateOne({ email }, { $set: { twoFASecret: secret.base32 } });

        const otpauthUrl = speakeasy.otpauthURL({
            secret: secret.ascii,
            label: `Goatmail:${email}`,
            issuer: "Goatmail",
        });

        const qrCodeDataURL = await QRCode.toDataURL(otpauthUrl);

        return { secret: secret.base32, qrCode: qrCodeDataURL };
    });

    fastify.post("/2fa/verify", async(req, reply) => {
        const { email, token } = req.body;

        const user = await users().findOne({ email });
        if (!user || !user.twoFASecret)
            return reply.code(400).send({ error: "2FA not set up" });

        const verified = speakeasy.totp.verify({
            secret: user.twoFASecret,
            encoding: "base32",
            token,
            window: 1,
        });

        if (!verified) return reply.code(400).send({ error: "Invalid 2FA code" });

        await users().updateOne({ email }, { $set: { twoFAEnabled: true } });
        return { message: "2FA enabled successfully" };
    });

    fastify.post("/recovery-email", async(req, reply) => {
        const { email, recoveryEmail } = req.body;
        if (!email || !recoveryEmail)
            return reply.code(400).send({ error: "Missing fields" });

        await users().updateOne({ email }, { $set: { recoveryEmail } });

        return { success: true };
    });

    fastify.post("/subscribe", async(req, reply) => {
        try {
            const { email, plan, billingCycle, cost } = req.body;
            if (!email || !plan) {
                return reply
                    .status(400)
                    .send({ message: "Email and plan are required" });
            }

            const subscription = {
                email,
                plan,
                billingCycle,
                cost,
                subscribedAt: new Date(),
            };

            await users().updateOne({ email }, { $set: { subscription } });
            return reply.status(200).send({
                message: "Subscription successful",
                subscription,
            });
        } catch (err) {
            request.log.error(err);
            return reply.status(500).send({ message: "Server error" });
        }
    });

    fastify.get("/plans", async(req, reply) => {
        try {
            const plans = await plansCollection.findOne({});
            if (!plans) {
                return reply.status(404).send({ error: "No plans found" });
            }

            return reply.send(plans);
        } catch (err) {
            req.log.error(err);
            return reply.status(500).send({ error: "Failed to fetch plans" });
        }
    });
};

export default authRoutes;

//   fastify.post("/login", async (req, reply) => {
//     const { email, password } = req.body;
//     const user = await users().findOne({ email });

//     if (!user || !user.password) {
//       return reply.code(400).send({ error: "Invalid credentials" });
//     }

//     const match = await bcrypt.compare(password, user.password);
//     if (!match) return reply.code(400).send({ error: "Invalid credentials" });

//     const token = jwt.sign(
//       { userId: user._id, email: user.email },
//       process.env.JWT_SECRET,
//       { expiresIn: "1h" }
//     );

//     return { message: "Login successful", token };
//   });
// }