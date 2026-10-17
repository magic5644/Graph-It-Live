import { button } from "@ws/ui";
import { formatDate } from "@ws/core";
import { homePage } from "./pages/home";

export const app = [button("open"), formatDate(0), homePage()];
