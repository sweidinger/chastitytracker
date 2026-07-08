"use client";

import { useState, useCallback, useRef } from "react";
import { compressImage } from "@/lib/compressImage";
import type { Rotation } from "@/lib/constants";

export type SealState = "idle" | "detecting" | "detected" | "not-detected";
export type DeviceDetectionState = "idle" | "detecting" | "detected" | "not-detected";

export interface DeviceSuggestion {
  deviceId: string;
  deviceName: string;
}

interface UsePhotoUploadOptions {
  /** Current startTime for EXIF time comparison. */
  startTime: string;
  /** Translate EXIF warnings. Return a display string. */
  exifWarningText?: (type: "deviation" | "missing", hours?: number) => string;
  /** Translate upload error message. Return a display string. */
  uploadErrorText?: () => string;
  /** Auto-detect seal number from photo (Verschluss only). Default false. */
  enableSealDetection?: boolean;
  /** Auto-detect device from photo by comparing against reference images. Default false. */
  enableDeviceDetection?: boolean;
  /** Initial values (for edit mode). */
  initial?: {
    imageUrl?: string | null;
    imageExifTime?: string | null;
    kontrollCode?: string | null;
  };
}

export function usePhotoUpload({
  startTime,
  exifWarningText,
  uploadErrorText,
  enableSealDetection = false,
  enableDeviceDetection = false,
  initial,
}: UsePhotoUploadOptions) {
  const [imageUrl, setImageUrl] = useState(initial?.imageUrl ?? "");
  const [imageExifTime, setImageExifTime] = useState(initial?.imageExifTime ?? "");
  const [imagePreview, setImagePreview] = useState(initial?.imageUrl ?? "");
  const [uploading, setUploading] = useState(false);
  const [exifWarning, setExifWarning] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [sealNumber, setSealNumber] = useState(initial?.kontrollCode ?? "");
  const [sealState, setSealState] = useState<SealState>("idle");
  const [deviceSuggestion, setDeviceSuggestion] = useState<DeviceSuggestion | null>(null);
  const [deviceDetectionState, setDeviceDetectionState] = useState<DeviceDetectionState>("idle");
  const [rotation, setRotation] = useState<Rotation>(0);
  const blobUrlRef = useRef<string | null>(null);
  // Ref so rotate callbacks always see the latest imageUrl without stale closure
  const imageUrlRef = useRef(imageUrl);
  imageUrlRef.current = imageUrl;

  const runDeviceDetection = useCallback(async (url: string) => {
    setDeviceDetectionState("detecting");
    setDeviceSuggestion(null);
    try {
      const res = await fetch("/api/detect-device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: url }),
      });
      if (res.ok) {
        const { deviceId, deviceName } = await res.json() as { deviceId: string | null; deviceName: string | null };
        if (deviceId && deviceName) {
          setDeviceSuggestion({ deviceId, deviceName });
          setDeviceDetectionState("detected");
        } else {
          setDeviceDetectionState("not-detected");
        }
      } else {
        setDeviceDetectionState("not-detected");
      }
    } catch {
      setDeviceDetectionState("not-detected");
    }
  }, []);

  const runSealDetection = useCallback(async (url: string, rot: Rotation) => {
    setSealState("detecting");
    try {
      const detectRes = await fetch("/api/detect-seal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: url, rotation: rot }),
      });
      if (detectRes.ok) {
        const { detected } = await detectRes.json() as { detected: string | null };
        if (detected) {
          setSealNumber(detected);
          setSealState("detected");
        } else {
          setSealState("not-detected");
        }
      } else {
        setSealState("not-detected");
      }
    } catch {
      setSealState("not-detected");
    }
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setUploading(true);
    setExifWarning("");
    setUploadError("");
    setRotation(0);
    if (enableSealDetection) setSealState("idle");
    if (enableDeviceDetection) { setDeviceDetectionState("idle"); setDeviceSuggestion(null); }
    // Read lastModified BEFORE any async yield (iOS Safari strips EXIF from uploads).
    const clientExifTime = file.lastModified ? new Date(file.lastModified).toISOString() : null;

    // Eagerly buffer file bytes before the first async yield.
    // On iOS Safari, the File's backing data can be reclaimed after the file input is
    // cleared (PhotoCapture does `e.target.value = ""` synchronously after calling onFile,
    // which fires right as this function first suspends). Using a plain ArrayBuffer keeps
    // the bytes alive in the JS heap regardless of the input element's state.
    // This fixes selfie-camera uploads which iOS appears to mark reclaimable faster.
    let safeFile: File = file;
    try {
      const bytes = await file.arrayBuffer();
      safeFile = new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
    } catch { /* keep original file — arrayBuffer() only fails on a truly dead file */ }

    // Clear previous blob URL. On iOS, keeping a large decoded HEIC in the img element
    // while the canvas starts on a new one can cause the WebContent process to OOM-crash.
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setImagePreview("");
    setImageUrl("");
    imageUrlRef.current = "";

    const blobUrl = URL.createObjectURL(safeFile);
    blobUrlRef.current = blobUrl;
    setImagePreview(blobUrl);

    const compressed = await compressImage(safeFile).catch(() => safeFile);

    function abortUpload(serverMsg?: string) {
      URL.revokeObjectURL(blobUrl);
      blobUrlRef.current = null;
      setImagePreview("");
      setImageUrl("");
      imageUrlRef.current = "";
      setImageExifTime("");
      setUploadError(serverMsg ?? (uploadErrorText ? uploadErrorText() : "Upload failed"));
      setUploading(false);
    }

    let res: Response;
    try {
      const fd = new FormData();
      fd.append("file", compressed);
      if (clientExifTime) fd.append("clientExifTime", clientExifTime);
      res = await fetch("/api/upload", { method: "POST", body: fd });
    } catch {
      abortUpload();
      return;
    }

    if (!res.ok) {
      // Show actual server error message so user knows what went wrong
      const errData = await res.json().catch(() => null) as { error?: string } | null;
      abortUpload(errData?.error ?? undefined);
      return;
    }

    let data: { url: string; exifTime?: string };
    try {
      data = await res.json() as { url: string; exifTime?: string };
    } catch {
      abortUpload();
      return;
    }

    setImageUrl(data.url);
    imageUrlRef.current = data.url;
    // Keep blob URL for preview — server URL requires an existing entry for ownership check
    setImageExifTime(data.exifTime ?? "");

    // EXIF time validation
    if (exifWarningText) {
      if (data.exifTime && startTime) {
        const diff = Math.abs(new Date(data.exifTime).getTime() - new Date(startTime).getTime());
        if (diff > 3600000) {
          setExifWarning(exifWarningText("deviation", Math.round(diff / 3600000)));
        }
      } else if (!data.exifTime) {
        setExifWarning(exifWarningText("missing"));
      }
    }
    setUploading(false);

    // Fire-and-forget: detection is non-blocking. Awaiting here would keep handleFile
    // alive after setUploading(false), causing a race condition if the user immediately
    // tries to replace the photo (second handleFile starts while first is still awaiting).
    void Promise.all([
      enableSealDetection ? runSealDetection(data.url, 0) : Promise.resolve(),
      enableDeviceDetection ? runDeviceDetection(data.url) : Promise.resolve(),
    ]);
  }, [startTime, exifWarningText, uploadErrorText, enableSealDetection, enableDeviceDetection, runSealDetection, runDeviceDetection]);

  const rotateLeft = useCallback(() => {
    setRotation(prev => {
      const next = ((prev - 90 + 360) % 360) as Rotation;
      if (enableSealDetection && imageUrlRef.current) {
        runSealDetection(imageUrlRef.current, next);
      }
      return next;
    });
  }, [enableSealDetection, runSealDetection]);

  const rotateRight = useCallback(() => {
    setRotation(prev => {
      const next = ((prev + 90) % 360) as Rotation;
      if (enableSealDetection && imageUrlRef.current) {
        runSealDetection(imageUrlRef.current, next);
      }
      return next;
    });
  }, [enableSealDetection, runSealDetection]);

  const clearPhoto = useCallback(() => {
    if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
    setImageUrl("");
    setImagePreview("");
    setImageExifTime("");
    setExifWarning("");
    setUploadError("");
    setSealState("idle");
    setDeviceDetectionState("idle");
    setDeviceSuggestion(null);
    setRotation(0);
  }, []);

  return {
    imageUrl, setImageUrl,
    imageExifTime, setImageExifTime,
    imagePreview, setImagePreview,
    uploading,
    exifWarning, setExifWarning,
    uploadError, setUploadError,
    sealNumber, setSealNumber,
    sealState, setSealState,
    deviceSuggestion, setDeviceSuggestion,
    deviceDetectionState, setDeviceDetectionState,
    rotation, rotateLeft, rotateRight,
    handleFile,
    clearPhoto,
  };
}
