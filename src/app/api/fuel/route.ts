import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, formFiles, formNum, formStr, ok, readForm } from "@/lib/http";
import { saveUpload, UploadError } from "@/lib/storage";
import { requestFuel } from "@/lib/actions";

// คนขับ asks for fuel: vehicle + engine hours + dashboard photo (+ odometer and its photo when the vehicle has one)
// -> the fillers are told.
export async function POST(req: Request) {
  const a = await apiUser(["driver"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const fd = await readForm(req);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const photo = formFiles(fd, "photo")[0];
  const odoPhoto = formFiles(fd, "odoPhoto")[0];
  const odometer = formNum(fd, "odometer");
  if (odoPhoto && odometer === null) return bad("กรอกเลขไมค์ตามรูป");
  let vehicleId: string;
  try {
    const r = await requestFuel(
      u,
      {
        vehicleId: formStr(fd, "vehicleId", 40),
        newCode: formStr(fd, "newCode", 31),
        newModel: formStr(fd, "newModel", 101),
        driverName: formStr(fd, "driverName", 60),
        hours: formNum(fd, "engineHours"),
        odometer,
      },
      async () => {
        if (!photo) throw new UploadError("กรุณาถ่ายรูปหน้าปัด");
        if (odometer !== null && !odoPhoto) throw new UploadError("กรุณาถ่ายรูปเลขไมค์");
        return {
          dashPhoto: await saveUpload(photo, "fuel-dash"),
          odoPhoto: odoPhoto && odometer !== null ? await saveUpload(odoPhoto, "fuel-dash") : null,
        };
      }
    );
    if ("error" in r) return bad(r.error, r.status);
    vehicleId = String(r.data.vehicleId);
  } catch (e) {
    if (e instanceof UploadError) return bad(e.message);
    throw e;
  }
  // "จำข้อมูลไว้": the vehicle checked out above (a typed plate: the vehicle it became)
  const remember = fd.has("remember") ? vehicleId : null;
  if (remember !== u.rememberVehicleId) await prisma.user.update({ where: { id: u.id }, data: { rememberVehicleId: remember } });
  return ok({ redirect: "/driver/fuel" });
}
