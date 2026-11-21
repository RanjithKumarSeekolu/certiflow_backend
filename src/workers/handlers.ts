import { CertificateService } from "../modules/certificates/certificate.service";
import { publish, Handler } from "../queues/broker";
import { Q } from "../queues/queue-names";
import { emitBatchEvent } from "../realtime/events";

/** batch.issue -> one certificate row per candidate, then fan out one render (or deliver) job each. */
export const issueBatch: Handler = async ({ batchId }) => {
  const certificates = await CertificateService.ensureCertificates(batchId);
  if (!certificates) return; // batch gone or not APPROVED: nothing to do
  for (const c of certificates) {
    await publish(c.pdfUrl ? Q.deliver : Q.render, { certificateId: c.id });
  }
  await emitBatchEvent(batchId, "certificates.issued");
};

/** certificate.render -> PDF, then hand over to delivery. */
export const renderCertificate: Handler = async ({ certificateId }) => {
  if (await CertificateService.renderPdf(certificateId)) await publish(Q.deliver, { certificateId });
};

/** certificate.deliver -> one WhatsApp attempt; the queue retries failures. */
export const deliverCertificate: Handler = async ({ certificateId }) => {
  await CertificateService.deliverCertificate(certificateId);
};

export const onDeliveryExhausted = async ({ certificateId }: { certificateId: string }, err: Error) => {
  await CertificateService.markDeliveryExhausted(certificateId, String(err?.message));
};
