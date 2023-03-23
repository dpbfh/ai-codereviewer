import { readFileSync } from "fs";
import * as taskLib from "azure-pipelines-task-lib/task";
import { Configuration, OpenAIApi } from "openai";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const AZURE_DEVOPS_TOKEN: string = taskLib.getInput("AZURE_DEVOPS_TOKEN", true);
const OPENAI_API_KEY: string = taskLib.getInput("OPENAI_API_KEY", true);

const configuration = new Configuration({
  apiKey: OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

const azureDevOpsApi = new AzureDevOpsApi(AZURE_DEVOPS_TOKEN);

interface PRDetails {
  projectId: string;
  repositoryId: string;
  pullRequestId: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const pr = await azureDevOpsApi.getPullRequest();
  return {
    projectId: pr.projectId,
    repositoryId: pr.repositoryId,
    pullRequestId: pr.pullRequestId,
    title: pr.title,
    description: pr.description,
  };
}

async function getDiff(
  projectId: string,
  repositoryId: string,
  pullRequestId: number
): Promise<string | null> {
  const response = await azureDevOpsApi.getPullRequestDiff(
    projectId,
    repositoryId,
    pullRequestId
  );
  return response;
}


async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const comment = createComment(file, chunk, aiResponse);
        if (comment) {
          comments.push(comment);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `
Review the following code changes in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Title: ${prDetails.title}

Description:

---
${prDetails.description}
---

Please provide comments and suggestions ONLY if there is something to improve, write the answer in Github markdown. If the code looks good, DO NOT return any text (leave the response completely empty)

${chunk.content}
${chunk.changes
  .map((c) => (c.type === "add" ? "+" : "-") + " " + c.content)
  .join("\n")}
`;
}

async function getAIResponse(prompt: string): Promise<string | null> {
  const queryConfig = {
    model: "gpt-4",
    temperature: 0.2,
    max_tokens: 400,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.createChatCompletion({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    return response.data.choices[0].message?.content?.trim() || null;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponse: string
): { body: string; path: string; line: number } | null {
  const lastAddChange = [...chunk.changes]
    .reverse()
    .find((c) => c.type === "add");
  if (lastAddChange && file.to) {
    return {
      body: aiResponse,
      path: file.to,
      // @ts-expect-error below properties exists on AddChange
      line: lastAddChange.ln || lastAddChange.ln1,
    };
  }
  return null;
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

(async function main() {
  const prDetails = await getPRDetails();
  const diff = await getDiff(
    prDetails.projectId,
    prDetails.repositoryId,
    prDetails.pullRequestId
  );
  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);
  const excludePatterns = taskLib
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await azureDevOpsApi.createReviewComment(
      prDetails.projectId,
      prDetails.repositoryId,
      prDetails.pullRequestId,
      comments
    );
  }
})().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
