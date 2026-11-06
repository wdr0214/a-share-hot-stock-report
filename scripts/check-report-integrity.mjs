import { preparePublishedReports } from "../api/_github-report-job.mjs";

console.log(JSON.stringify(await preparePublishedReports(process.cwd())));
