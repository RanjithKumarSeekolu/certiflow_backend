import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

export interface CertificatePdfData {
  certificateNumber: string;
  candidateName: string;
  courseName: string;
  grade: string;
  score: number;
  issueDate: string;
  verificationHash: string;
  verificationUrl: string;
}

export class PdfCertificateGenerator {
  private static outputDir = path.resolve(process.cwd(), "uploads/certificates");

  static ensureOutputDir(): string {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    return this.outputDir;
  }

  static async generateCertificatePdf(data: CertificatePdfData): Promise<string> {
    this.ensureOutputDir();
    const fileName = `${data.certificateNumber}.pdf`;
    const filePath = path.join(this.outputDir, fileName);

    return new Promise((resolve, reject) => {
      // Landscape A4 certificate
      const doc = new PDFDocument({
        layout: "landscape",
        size: "A4",
        margin: 40,
      });

      const writeStream = fs.createWriteStream(filePath);
      doc.pipe(writeStream);

      // Certificate Border
      doc
        .lineWidth(4)
        .strokeColor("#1E3A8A") // Deep Blue
        .rect(20, 20, 752, 515)
        .stroke();

      doc
        .lineWidth(1.5)
        .strokeColor("#F59E0B") // Amber Gold inner accent
        .rect(26, 26, 740, 503)
        .stroke();

      // Header
      doc
        .moveDown(2)
        .font("Helvetica-Bold")
        .fontSize(28)
        .fillColor("#1E3A8A")
        .text("PRAGATI SKILLS MISSION", { align: "center" });

      doc
        .fontSize(14)
        .font("Helvetica")
        .fillColor("#4B5563")
        .text("Government Skilling & Vocational Training Authority", { align: "center" });

      doc.moveDown(1);
      doc
        .fontSize(22)
        .font("Helvetica-Bold")
        .fillColor("#D97706")
        .text("CERTIFICATE OF COMPLETION", { align: "center" });

      doc.moveDown(1.5);
      doc
        .fontSize(14)
        .font("Helvetica")
        .fillColor("#374151")
        .text("This is proudly presented to", { align: "center" });

      doc.moveDown(0.5);
      doc
        .fontSize(26)
        .font("Helvetica-Bold")
        .fillColor("#111827")
        .text(data.candidateName, { align: "center", underline: true });

      doc.moveDown(0.8);
      doc
        .fontSize(14)
        .font("Helvetica")
        .fillColor("#374151")
        .text(
          `for successfully completing the skill certification in`,
          { align: "center" }
        );

      doc.moveDown(0.3);
      doc
        .fontSize(18)
        .font("Helvetica-Bold")
        .fillColor("#1E3A8A")
        .text(data.courseName, { align: "center" });

      doc.moveDown(0.5);
      doc
        .fontSize(12)
        .font("Helvetica")
        .fillColor("#4B5563")
        .text(`Score: ${data.score}%   |   Grade: ${data.grade}`, { align: "center" });

      // Footer Information
      doc.y = 440;
      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .fillColor("#1F2937")
        .text(`Certificate No: ${data.certificateNumber}`, 40, 440)
        .text(`Issue Date: ${data.issueDate}`, 40, 455)
        .text(`Verify URL: ${data.verificationUrl}`, 40, 470);

      doc
        .fontSize(8)
        .font("Helvetica")
        .fillColor("#6B7280")
        .text(`Tamper-evident Hash: ${data.verificationHash}`, 40, 490, { width: 700 });

      doc.end();

      writeStream.on("finish", () => {
        resolve(`/certificates/${fileName}`);
      });

      writeStream.on("error", (err) => {
        reject(err);
      });
    });
  }
}

