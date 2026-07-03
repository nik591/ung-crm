import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          persistSession: false,
        },
      }
    );

    const bucketName = process.env.SUPABASE_MEDIA_BUCKET ?? "whatsapp-media";

    // 1. Ensure the bucket exists and is public
    try {
      const { data: buckets, error: listError } = await supabase.storage.listBuckets();
      
      if (listError) {
        console.error("List buckets error:", listError);
      }

      const bucketExists = buckets?.some((b) => b.name === bucketName);

      if (!bucketExists) {
        console.log(`Bucket '${bucketName}' does not exist. Attempting to create it...`);
        const { error: createError } = await supabase.storage.createBucket(bucketName, {
          public: true,
        });
        if (createError) {
          console.error(`Failed to create bucket '${bucketName}':`, createError);
        } else {
          console.log(`Bucket '${bucketName}' created successfully and set to public.`);
        }
      }
    } catch (bucketErr) {
      console.error("Storage bucket check/create failed:", bucketErr);
    }

    // 2. Upload file
    const fileExt = file.name.split(".").pop();
    const randomId = Math.random().toString(36).substring(2, 15);
    const fileName = `${randomId}-${Date.now()}.${fileExt}`;
    
    const buffer = Buffer.from(await file.arrayBuffer());

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(fileName, buffer, {
        contentType: file.type,
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase Storage upload error details:", uploadError);
      throw uploadError;
    }

    // 3. Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return NextResponse.json({ 
      success: true, 
      url: publicUrl, 
      name: file.name, 
      type: file.type 
    });
  } catch (err) {
    console.error("Upload route general error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 500 }
    );
  }
}
