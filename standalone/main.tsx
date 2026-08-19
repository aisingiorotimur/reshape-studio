import { createRoot } from "react-dom/client";
import "../app/globals.css";
import ReshapeStudio from "../app/ReshapeStudio";

const root = document.getElementById("root");

if (!root) {
  throw new Error("RE/SHAPE 无法找到页面挂载点。");
}

createRoot(root).render(<ReshapeStudio />);
