import { NextRequest, NextResponse } from "next/server";
import { requireKeyholderOrAdminApi } from "@/lib/authGuards";
import { createTask, type CreateTaskParams } from "@/lib/taskService";
import { errorResponse, serviceFailure } from "@/lib/serviceResult";

/** Keyholder stellt dem Sub eine Aufgabe. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const err = await requireKeyholderOrAdminApi(body.userId);
    if (err) return err;

    const holdUntil = new Date(body.holdUntil);
    if (Number.isNaN(holdUntil.getTime())) return errorResponse(400, "INVALID_DATETIME");

    const params: CreateTaskParams = {
      userId: body.userId,
      title: body.title,
      description: body.description,
      holdUntil,
      startGraceMin: body.startGraceMin,
      isPunishment: body.isPunishment,
      penaltyReason: body.penaltyReason,
      requirements: body.requirements,
      proofs: body.proofs,
    };

    // Fork: "Strafaufgabe" (Vergehen mit Aufgabe bestrafen via punishWithTask) ist ein eigenes
    // Increment - haengt am Posteingang + strafurteil-Refactor. Hier nur normale Aufgabenerstellung.
    const result = await createTask(params);
    if (!result.ok) return serviceFailure(result);
    return NextResponse.json({ ok: true, id: result.data.id });
  } catch (err) {
    console.error("[POST /api/admin/tasks]", err);
    return errorResponse(500, "INTERNAL_ERROR");
  }
}
