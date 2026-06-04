declare module 'twilio' {
  interface MessageCreateOptions {
    body: string;
    from: string;
    to: string;
  }
  interface MessagesResource {
    create(opts: MessageCreateOptions): Promise<{ sid: string }>;
  }
  interface TwilioClient {
    messages: MessagesResource;
  }
  function twilio(accountSid: string, authToken: string): TwilioClient;
  export = twilio;
}
