declare module 'twilio' {
  interface MessageCreateOptions {
    body: string;
    from: string;
    to: string;
  }
  interface VerificationCreateOptions {
    to: string;
    channel: 'sms' | 'call' | 'email';
  }
  interface VerificationCheckCreateOptions {
    to: string;
    code: string;
  }
  interface VerificationInstance {
    status: string;
    sid: string;
  }
  interface VerificationsResource {
    create(opts: VerificationCreateOptions): Promise<VerificationInstance>;
  }
  interface VerificationChecksResource {
    create(opts: VerificationCheckCreateOptions): Promise<VerificationInstance>;
  }
  interface VerifyServiceContext {
    verifications: VerificationsResource;
    verificationChecks: VerificationChecksResource;
  }
  interface VerifyServiceList {
    (sid: string): VerifyServiceContext;
  }
  interface VerifyV2 {
    services: VerifyServiceList;
  }
  interface VerifyResource {
    v2: VerifyV2;
  }
  interface TwilioClient {
    messages: { create(opts: MessageCreateOptions): Promise<{ sid: string }> };
    verify: VerifyResource;
  }
  function twilio(accountSid: string, authToken: string): TwilioClient;
  export = twilio;
}
