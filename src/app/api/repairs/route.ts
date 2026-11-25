import { apiUser } from "@/lib/session";
import { bad, formFiles, formNum, formStr, ok, readForm } from "@/lib/http";
import { removeUpload, saveUpload, UploadError } from "@/lib/storage";
import { openRepair } from "@/lib/actions";

// คนขับแจ้งซ่อม -> quote (จัดซื้อหาใบเสนอราคา). Urgent ones also reach the executives at once.
export async function POST(req: Request) {
  const a = await apiUser(["driver"]);
  if ("res" in a) return a.res;
  const fd = await readForm(req);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const files = formFiles(fd, "photos");
  try {
    const r = await openRepair(
      a.user,
      {
        vehicleId: formStr(fd, "vehicleId", 40),
        newCode: formStr(fd, "newCode", 31),
        newModel: formStr(fd, "newModel", 101),
        driverName: formStr(fd, "driverName", 60),
        // Browsers send textarea line breaks as \r\n; count them as one character like the form does.
        symptom: formStr(fd, "symptom", 1100).replace(/\r\n/g, "\n"),
        cause: formStr(fd, "cause", 1100).replace(/\r\n/g, "\n"),
        odometer: formNum(fd, "odometer"),
        pmRound: formStr(fd, "pmRound", 101),
        urgency: formStr(fd, "urgency", 20),
        fromPm: formStr(fd, "fromPm", 1) === "1",
      },
      async () => {
        if (files.length < 1 || files.length > 10) throw new UploadError("แนบรูปอาการเสีย 1-10 รูป");
        const keys: string[] = [];
        try {
          for (const f of files) keys.push(await saveUpload(f, "repair"));
        } catch (e) {
          await Promise.all(keys.map(removeUpload)); // one photo refused: no report, so none of them is kept
          throw e;
        }
        return keys;
      }
    );
    return "error" in r ? bad(r.error, r.status) : ok({ redirect: "/driver/my" });
  } catch (e) {
    if (e instanceof UploadError) return bad(e.message);
    throw e;
  }
}
