import { Navigate, Route, Routes } from "react-router-dom";

import { HomePage } from "@/routes/HomePage";
import { SignInPage } from "@/routes/SignInPage";
import { OkPage } from "@/routes/OkPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/signin" element={<SignInPage />} />
      <Route path="/ok" element={<OkPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
