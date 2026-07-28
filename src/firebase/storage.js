import { getStorage } from "firebase/storage";
import { app } from "./config";

export const storage = getStorage(app);
console.log(storage);
console.log("Firebase Storage initialized:", storage);
