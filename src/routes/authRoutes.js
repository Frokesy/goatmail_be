import dotenv from "dotenv";
import { createRequire } from "module";

dotenv.config();

const require = createRequire(
    import.meta.url);
const { sendOtpEmail } = require("../utils/email/sendOtp.js");
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const authRoutes = async(fastify, options) => {
    const users = () => fastify.mongo.db.collection("users");

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