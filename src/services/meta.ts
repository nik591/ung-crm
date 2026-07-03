const META_API = "https://graph.facebook.com/v19.0";

function normalizePhoneForMeta(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("00") ? digits.slice(2) : digits;
}

function parseMetaError(data: unknown, fallback: string) {
  const payload = data as Record<string, any> | undefined;
  return payload?.error?.message ?? payload?.error?.error_user_msg ?? fallback;
}

export async function sendWhatsAppTemplate(
  phone: string,
  templateName: string,
  templateLanguage: string,
  headerImageUrl?: string,
  contactName?: string
) {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    return {
      ok: false,
      wamid: null,
      error: "Missing META_PHONE_NUMBER_ID or META_ACCESS_TOKEN",
    };
  }

  const recipient = normalizePhoneForMeta(phone);
  if (!recipient) {
    return {
      ok: false,
      wamid: null,
      error: "Recipient phone number is invalid",
    };
  }

  const bodyComponent = {
    type: "body",
    parameters: [
      {
        type: "text",
        text: contactName || "Customer",
      },
    ],
  };

  const templatePayload: Record<string, any> = {
    name: templateName,
    language: { code: templateLanguage },
    components: [bodyComponent],
  };

  if (headerImageUrl) {
    templatePayload.components.unshift({
      type: "header",
      parameters: [
        {
          type: "image",
          image: { link: headerImageUrl },
        },
      ],
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    to: recipient,
    type: "template",
    template: templatePayload,
  };

  console.log("WhatsApp template payload:", JSON.stringify(payload, null, 2));

  const res = await fetch(`${META_API}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let data: Record<string, any> = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  console.log("WhatsApp Meta status:", res.status);
  console.log("WhatsApp Meta response:", JSON.stringify(data, null, 2));

  return {
    ok: res.ok,
    wamid: data.messages?.[0]?.id ?? null,
    error: res.ok ? null : parseMetaError(data, "Meta rejected the template message"),
  };
}

export async function sendWhatsAppText(phone: string, message: string) {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    return {
      ok: false,
      wamid: null,
      error: "Missing META_PHONE_NUMBER_ID or META_ACCESS_TOKEN",
    };
  }

  const recipient = normalizePhoneForMeta(phone);
  if (!recipient) {
    return {
      ok: false,
      wamid: null,
      error: "Recipient phone number is invalid",
    };
  }

  const res = await fetch(`${META_API}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipient,
      type: "text",
      text: { body: message },
    }),
  });

  let data: Record<string, any> = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  return {
    ok: res.ok,
    wamid: data.messages?.[0]?.id ?? null,
    error: res.ok ? null : parseMetaError(data, "Meta rejected the text message"),
  };
}

export async function sendWhatsAppMedia(
  phone: string,
  mediaUrl: string,
  mediaType: "image" | "video" | "audio" | "document",
  caption?: string,
  filename?: string
) {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    return {
      ok: false,
      wamid: null,
      error: "Missing META_PHONE_NUMBER_ID or META_ACCESS_TOKEN",
    };
  }

  const recipient = normalizePhoneForMeta(phone);
  if (!recipient) {
    return {
      ok: false,
      wamid: null,
      error: "Recipient phone number is invalid",
    };
  }

  const mediaObject: Record<string, any> = {
    link: mediaUrl,
  };

  if (caption && (mediaType === "image" || mediaType === "video" || mediaType === "document")) {
    mediaObject.caption = caption;
  }

  if (mediaType === "document" && filename) {
    mediaObject.filename = filename;
  }

  const payload = {
    messaging_product: "whatsapp",
    to: recipient,
    type: mediaType,
    [mediaType]: mediaObject,
  };

  console.log(`WhatsApp media payload (${mediaType}):`, JSON.stringify(payload, null, 2));

  const res = await fetch(`${META_API}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let data: Record<string, any> = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  console.log("WhatsApp Meta media status:", res.status);
  console.log("WhatsApp Meta media response:", JSON.stringify(data, null, 2));

  return {
    ok: res.ok,
    wamid: data.messages?.[0]?.id ?? null,
    error: res.ok ? null : parseMetaError(data, `Meta rejected the ${mediaType} message`),
  };
}

