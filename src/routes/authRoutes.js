import dotenv from "dotenv";
import { createRequire } from "module";

dotenv.config();

const require = createRequire(
    import.meta.url);
const { sendOtpEmail } = require("../utils/email/sendOtp.cjs");

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

        await sendOtpEmail(email, otp);

        return rep.code(200).send({ message: "OTP sent", otp });
    });
};

export default authRoutes;