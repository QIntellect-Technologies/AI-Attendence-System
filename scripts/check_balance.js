const fs = require("fs");
const p =
  "frontend/src/app/client-dashboard/pages/StaffManagement/VisitPlansTab.tsx";
const s = fs.readFileSync(p, "utf8");
const counts = {
  "{": (s.match(/{/g) || []).length,
  "}": (s.match(/}/g) || []).length,
  "(": (s.match(/\(/g) || []).length,
  ")": (s.match(/\)/g) || []).length,
  "<>": (s.match(/<>/g) || []).length,
  "</>": (s.match(/<\/\>/g) || []).length,
};
console.log(counts);
