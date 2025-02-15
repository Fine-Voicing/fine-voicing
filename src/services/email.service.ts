import nodemailer from 'nodemailer';
import { log } from '../utils/logger.js';
import { EmailContext, ConversationItem } from '../types/index.js';

export class EmailService {
    private transporter: nodemailer.Transporter;
    private readonly senderEmail: string;
    private readonly bccEmail: string;

    constructor() {
        const smtpServer = process.env.SMTP_SERVER;
        const smtpPort = parseInt(process.env.SMTP_PORT || '587');
        const senderEmail = process.env.EMAIL_USER;
        const senderPassword = process.env.EMAIL_PASSWORD;
        const bccEmail = process.env.BCC_EMAIL;

        if (!smtpServer || !senderEmail || !senderPassword) {
            throw new Error('SMTP_SERVER, EMAIL_USER, and EMAIL_PASSWORD must be set');
        }

        this.senderEmail = senderEmail;
        this.bccEmail = bccEmail || '';

        this.transporter = nodemailer.createTransport({
            host: smtpServer,
            port: smtpPort,
            secure: smtpPort === 465, // true for 465, false for other ports
            auth: {
                user: senderEmail,
                pass: senderPassword,
            },
        });
    }

    private sanitizeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private formatTranscriptHtml(transcripts: ConversationItem[]): string {
        let htmlContent = "<div class='transcript'>";  // Start the HTML container
        for (const entry of transcripts) {
            htmlContent += "  <div class='entry'>\n";  // Start a new entry
            htmlContent += `    <span class='role'><strong>${this.sanitizeHtml(entry.role_name || entry.role)}:</strong></span> <span class='content'>${this.sanitizeHtml(entry.content)}</span>\n`;  // Add role and content with bold
            htmlContent += "  </div>\n";  // End the entry
        }
        htmlContent += "</div>";  // End the HTML container
        return htmlContent;
    }

    async sendEmail(
        toEmail: string,
        emailContext: EmailContext
    ): Promise<void> {
        try {
            const htmlContent = `
                <p>Hi there!</p>
                <p>Fine Voicing just completed an outbound call to ${emailContext.to_phone_number}. Listen to it through <a href="${emailContext.secureLink}">this link</a> (expires in 7 days)</p>
                <p><a target='_blank' href='https://finevoicing.com/'>Log in</a> to your account to run more test outbound calls using Fine Voicing API.</p>
                <p>We are looking forward to your feedback!</p>
                <p><strong>System prompt:</strong> ${this.sanitizeHtml(emailContext.prompt)}</p>
                <p><strong>Transcript:</strong></p>${this.formatTranscriptHtml(emailContext.transcript)}
                <p>- The Fine Voicing team.</p>`;

            const mailOptions = {
                from: `Fine Voicing <${this.senderEmail}>`,
                to: toEmail,
                cc: this.bccEmail,
                replyTo: this.bccEmail,
                subject: `Summary of your outbound call to ${emailContext.to_phone_number}`,
                html: htmlContent,
            };

            await this.transporter.sendMail(mailOptions);
            log.info(`Email sent successfully to ${toEmail}`);
        } catch (error: any) {
            log.error(`Failed to send email: ${error.message}`);
            throw error;
        }
    }
} 