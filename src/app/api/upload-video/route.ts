import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { writeFile, mkdir } from "fs/promises";
import { join, extname } from "path";
import { uploadsDirPath } from "@/lib/imageUtils";
import { randomBytes } from "crypto";

const ALLOWED_VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "m4v"];
const MAX_VIDEO_SIZE = 200 * 1024 * 1024; // 200 MB

function isAllowedVideoBuffer(buf: Buffer): boolean {
  // MP4 / MOV / M4V: ftyp box at offset 4
  if (buf.length > 11 && buf.slice(4, 8).toString("ascii") === "ftyp") return true;
  // WebM: starts with EBML 0x1A 0x45 0xDF 0xA3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  return false;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await req.formData();
  const file = formData.get("video") as File | null;
  if (!file) return NextResponse.json({ error: "Kein Video ausgewählt" }, { status: 400 });

  console.log(`[upload-video] received: name=${file.name} size=${file.size} type=${file.type}`);

  const rawExt = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_VIDEO_EXTENSIONS.includes(rawExt)) {
    return NextResponse.json({ error: "Ungültiger Videotyp (erlaubt: mp4, mov, webm)" }, { status: 400 });
  }
  if (file.size > MAX_VIDEO_SIZE) {
    return NextResponse.json({ error: "Video zu groß (max. 200 MB)" }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  if (!isAllowedVideoBuffer(buffer)) {
    return NextResponse.json({ error: "Ungültiger Videotyp (MIME)" }, { status: 400 });
  }

  const uploadsDir = uploadsDirPath();
  await mkdir(uploadsDir, { recursive: true });

  const filename = `${randomBytes(16).toString("hex")}${extname(file.name).toLowerCase()}`;
  const filepath = join(uploadsDir, filename);
  await writeFile(filepath, buffer);

  console.log(`[upload-video] saved → ${filename}`);
  return NextResponse.json({ url: `/api/uploads/${filename}` });
}
