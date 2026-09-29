import { RouterProvider } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { supportRouter } from "./support-dashboard/routes";

export default function AppSupport() {
    return (
        <>
            <ToastContainer position="top-right" />
            <RouterProvider router={supportRouter} />
        </>
    );
}