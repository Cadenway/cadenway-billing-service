/** The provider can stop retrying only after acceptance or an intentional ignore. */
export type AdmitStripeWebhookOutput =
  'accepted' | 'ignored' | 'invalid-signature' | 'invalid-event' | 'body-too-large' | 'unavailable';
