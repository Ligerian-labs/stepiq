import { db } from "./index.js";
import { pipelineTemplates } from "./schema.js";

const templates = [
  {
    name: "Web Scraper",
    description: "Scrape data from websites and extract structured information",
    category: "web-scraping",
    definition: {
      name: "Web Scraper",
      version: 1,
      steps: [
        {
          id: "fetch_page",
          name: "Fetch Page",
          type: "llm",
          model: "gpt-5.2",
          prompt: "Fetch and extract content from {{input.url}}",
          output_format: "text",
        },
        {
          id: "parse_data",
          name: "Parse Data",
          type: "llm",
          model: "claude-sonnet-4",
          prompt:
            "Extract structured data from the following content:\n\n{{steps.fetch_page.output}}\n\nExtract: price, title, description",
          output_format: "json",
        },
      ],
      output: {
        from: "parse_data",
      },
    },
    tags: ["scraper", "web", "extraction"],
    isPublic: true,
  },
  {
    name: "Content Generator",
    description: "Generate blog posts, articles, and marketing content",
    category: "content-generation",
    definition: {
      name: "Content Generator",
      version: 1,
      steps: [
        {
          id: "research",
          name: "Research Topic",
          type: "llm",
          model: "gpt-5.2",
          prompt: "Research and outline key points about: {{input.topic}}",
          output_format: "text",
        },
        {
          id: "draft",
          name: "Draft Content",
          type: "llm",
          model: "claude-sonnet-4",
          prompt:
            "Write a comprehensive article based on this outline:\n\n{{steps.research.output}}\n\nTone: {{input.tone}}\nLength: {{input.length}}",
          output_format: "markdown",
        },
        {
          id: "edit",
          name: "Edit & Polish",
          type: "llm",
          model: "gpt-4o",
          prompt:
            "Edit and polish this content for clarity and engagement:\n\n{{steps.draft.output}}",
          output_format: "markdown",
        },
      ],
      output: {
        from: "edit",
      },
    },
    tags: ["content", "writing", "blog", "marketing"],
    isPublic: true,
  },
  {
    name: "API Integration",
    description: "Call external APIs and process the responses",
    category: "api-integration",
    definition: {
      name: "API Integration",
      version: 1,
      steps: [
        {
          id: "call_api",
          name: "Call API",
          type: "llm",
          model: "gpt-5.2",
          prompt:
            "Make a {{input.method}} request to {{input.endpoint}} with headers {{input.headers}}",
          output_format: "json",
          agent: {
            max_turns: 3,
            tools: [
              {
                type: "http_request",
                name: "make_request",
                description: "Make HTTP request to external API",
              },
            ],
          },
        },
        {
          id: "transform",
          name: "Transform Response",
          type: "llm",
          model: "gpt-4o-mini",
          prompt:
            "Transform this API response into the required format:\n\n{{steps.call_api.output}}",
          output_format: "json",
        },
      ],
      output: {
        from: "transform",
      },
    },
    tags: ["api", "integration", "http"],
    isPublic: true,
  },
  {
    name: "Data Processor",
    description: "Process and transform data through multiple stages",
    category: "data-processing",
    definition: {
      name: "Data Processor",
      version: 1,
      steps: [
        {
          id: "validate",
          name: "Validate Input",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Validate this data against the schema:\n\n{{input.data}}",
          output_format: "json",
        },
        {
          id: "transform",
          name: "Transform Data",
          type: "llm",
          model: "gpt-5.2",
          prompt: "Transform the validated data:\n\n{{steps.validate.output}}",
          output_format: "json",
        },
        {
          id: "format",
          name: "Format Output",
          type: "llm",
          model: "gpt-4o-mini",
          prompt:
            "Format the transformed data for output:\n\n{{steps.transform.output}}",
          output_format: "json",
        },
      ],
      output: {
        from: "format",
      },
    },
    tags: ["data", "processing", "etl", "transform"],
    isPublic: true,
  },
  {
    name: "Monitor & Alert",
    description: "Monitor systems and send alerts when issues detected",
    category: "monitoring",
    definition: {
      name: "Monitor & Alert",
      version: 1,
      steps: [
        {
          id: "check",
          name: "Check System",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Check the status of {{input.target}}",
          output_format: "json",
        },
        {
          id: "evaluate",
          name: "Evaluate Status",
          type: "llm",
          model: "gpt-4o-mini",
          prompt:
            "Evaluate if this status requires an alert:\n\n{{steps.check.output}}\n\nThreshold: {{input.threshold}}",
          output_format: "json",
        },
        {
          id: "alert",
          name: "Send Alert",
          type: "llm",
          model: "gpt-4o-mini",
          prompt:
            "Send alert notification based on evaluation:\n\n{{steps.evaluate.output}}",
          output_format: "text",
        },
      ],
      output: {
        from: "alert",
      },
    },
    tags: ["monitoring", "alert", "observability"],
    isPublic: true,
  },
];

export async function seedTemplates() {
  console.log("Seeding pipeline templates...");

  for (const template of templates) {
    await db.insert(pipelineTemplates).values(template).onConflictDoNothing();
  }

  console.log(`Seeded ${templates.length} templates`);
}

if (import.meta.main) {
  await seedTemplates();
  process.exit(0);
}
