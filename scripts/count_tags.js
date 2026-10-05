const fs=require('fs');const s=fs.readFileSync('frontend/src/app/client-dashboard/pages/StaffManagement/VisitPlansTab.tsx','utf8');
const counts = {
  divOpen: (s.match(/<div\b/g)||[]).length,
  divClose: (s.match(/<\\/div>/g)||[]).length,
  spanOpen: (s.match(/<span\b/g)||[]).length,
  spanClose: (s.match(/<\\/span>/g)||[]).length,
  buttonOpen: (s.match(/<button\b/g)||[]).length,
  buttonClose: (s.match(/<\\/button>/g)||[]).length,
};
console.log(counts);
