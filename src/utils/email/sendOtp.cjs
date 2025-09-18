const plunk = require("@plunk/node");
const fs = require("fs");
const path = require("path");

const templatePath = path.join(
    process.cwd(),
    "src/utils/email/otpTemplate.html"
);

const templateHtml = fs.readFileSync(templatePath, "utf-8");

async function sendOtpEmail(email, otp) {
    console.log(
        "Plunk API Key:",
        process.env.PLUNK_API_KEY ? "✅ Loaded" : "❌ Missing"
    );
    const html = templateHtml.replace("{{OTP}}", otp);

    await plunk.emails.send({
        to: email,
        subject: "Verify your email",
        body: html,
    });
}

module.exports = { sendOtpEmail };