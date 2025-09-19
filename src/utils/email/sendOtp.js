import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const templatePath = path.join(
    process.cwd(),
    "src/utils/email/otpTemplate.html"
);
const templateHtml = fs.readFileSync(templatePath, "utf-8");

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

export async function sendOtpEmail(email, otp) {
    const html = templateHtml.replace("{{OTP}}", otp);

    await transporter.sendMail({
        from: `frokeslini@gmail.com`,
        to: email,
        subject: "Verify your email",
        html,
    });
    console.log(`OTP sent to ${email}`);
}