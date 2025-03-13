import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";
import inquirer from "inquirer";

// Get __dirname equivalent in ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {Object} BoundingBox
 * @property {number} x - X coordinate
 * @property {number} y - Y coordinate
 * @property {number} width - Width of the bounding box
 * @property {number} height - Height of the bounding box
 */

/**
 * @typedef {Object} Transform
 * @property {number} x - X translation
 * @property {number} y - Y translation
 */

class SVGProcessor {
	static SVG_NAMESPACE = "http://www.w3.org/2000/svg";
	static DEFAULT_PADDING = 10;

	/**
	 * Parse SVG transform attribute
	 * @param {string} transform - Transform attribute string
	 * @returns {Transform} Parsed transform values
	 */
	static parseTransform(transform) {
		if (!transform) return { x: 0, y: 0 };
		const match = transform.match(/translate\(([-\d.]+)[, ]([-\d.]+)\)/);
		return match ? { x: parseFloat(match[1]), y: parseFloat(match[2]) } : { x: 0, y: 0 };
	}

	/**
	 * Calculate bounding box for an SVG group
	 * @param {Element} group - SVG group element
	 * @returns {BoundingBox} Calculated bounding box
	 */
	static calculateBBox(group) {
		let minX = Infinity,
			minY = Infinity;
		let maxX = -Infinity,
			maxY = -Infinity;
		let hasElements = false;

		const updateBoundsForElement = (element) => {
			const transform = this.parseTransform(element.getAttribute("transform"));

			switch (element.tagName.toLowerCase()) {
				case "rect":
					this.updateRectBounds(element, transform, bounds);
					hasElements = true;
					break;
				case "circle":
					this.updateCircleBounds(element, transform, bounds);
					hasElements = true;
					break;
				case "path":
					this.updatePathBounds(element, transform, bounds);
					hasElements = true;
					break;
				case "line":
					this.updateLineBounds(element, transform, bounds);
					hasElements = true;
					break;
				case "polyline":
				case "polygon":
					this.updatePolyBounds(element, transform, bounds);
					hasElements = true;
					break;
				case "text":
					this.updateTextBounds(element, transform, bounds);
					hasElements = true;
					break;
			}
		};

		const bounds = {
			update: (x, y) => {
				if (typeof x === "number" && !isNaN(x)) {
					minX = Math.min(minX, x);
					maxX = Math.max(maxX, x);
				}
				if (typeof y === "number" && !isNaN(y)) {
					minY = Math.min(minY, y);
					maxY = Math.max(maxY, y);
				}
			},
		};

		// Process group transform first
		const groupTransform = this.parseTransform(group.getAttribute("transform"));

		// Process all child elements
		Array.from(group.getElementsByTagName("*")).forEach(updateBoundsForElement);

		// Apply group transform to final bounds
		if (hasElements) {
			const width = maxX - minX;
			const height = maxY - minY;
			return {
				x: minX + (groupTransform.x || 0),
				y: minY + (groupTransform.y || 0),
				width: Math.max(1, width), // Ensure minimum size
				height: Math.max(1, height), // Ensure minimum size
			};
		}

		// Default size for empty groups
		return { x: 0, y: 0, width: 10, height: 10 };
	}

	/**
	 * Process an SVG file and extract groups into separate files
	 * @param {string} inputPath - Path to input SVG file
	 * @param {string} outputDir - Output directory path
	 */
	static async processSVG(inputPath, outputDir) {
		try {
			const svgContent = await fs.readFile(inputPath, "utf8");
			const dom = new JSDOM(svgContent, { contentType: "image/svg+xml" });
			const document = dom.window.document;
			const svgElement = document.querySelector("svg");

			if (!svgElement) {
				throw new Error("No SVG element found in the input file");
			}

			await this.ensureOutputDirectory(outputDir);
			const defsContent = this.extractDefsContent(svgElement);
			await this.processGroups(svgElement, defsContent, outputDir);

			console.log("SVG processing completed successfully!");
		} catch (error) {
			console.error("Error processing SVG file:", error.message);
			throw error;
		}
	}

	/**
	 * Ensure output directory exists
	 * @param {string} outputDir - Output directory path
	 */
	static async ensureOutputDirectory(outputDir) {
		try {
			await fs.access(outputDir);
		} catch {
			await fs.mkdir(outputDir, { recursive: true });
			console.log(`Created output directory: ${outputDir}`);
		}
	}

	/**
	 * Extract defs content from SVG
	 * @param {Element} svgElement - Root SVG element
	 * @returns {string} Combined defs content
	 */
	static extractDefsContent(svgElement) {
		return Array.from(svgElement.getElementsByTagName("defs"))
			.map((def) => def.outerHTML)
			.join("\n");
	}

	/**
	 * Process all groups in the SVG
	 * @param {Element} svgElement - Root SVG element
	 * @param {string} defsContent - Combined defs content
	 * @param {string} outputDir - Output directory path
	 */
	static async processGroups(svgElement, defsContent, outputDir) {
		const groups = Array.from(svgElement.getElementsByTagName("g"));
		console.log(`Processing ${groups.length} groups...`);

		for (const [index, group] of groups.entries()) {
			try {
				await this.exportGroup(group, defsContent, outputDir, index);
			} catch (error) {
				console.error(`Error processing group ${index + 1}:`, error.message);
			}
		}
	}

	/**
	 * Export a single group as an SVG file
	 * @param {Element} group - Group element to export
	 * @param {string} defsContent - Defs content to include
	 * @param {string} outputDir - Output directory
	 * @param {number} index - Group index
	 */
	static async exportGroup(group, defsContent, outputDir, index) {
		const groupId = group.getAttribute("id") || `group_${index + 1}`;
		const bbox = this.calculateBBox(group);
		const { width, height, viewBox } = this.calculateDimensions(bbox);

		const svgContent = this.generateSVGContent(group, defsContent, viewBox, width, height);
		const outputPath = path.join(outputDir, `${groupId}.svg`);

		await fs.writeFile(outputPath, svgContent);
		console.log(`Exported: ${outputPath} (${width}x${height})`);
	}

	/**
	 * Update bounds for a rect element
	 * @param {Element} element - Rect element
	 * @param {Transform} transform - Transform values
	 * @param {Object} bounds - Bounds object
	 */
	static updateRectBounds(element, transform, bounds) {
		const x = parseFloat(element.getAttribute("x") || 0) + transform.x;
		const y = parseFloat(element.getAttribute("y") || 0) + transform.y;
		const width = parseFloat(element.getAttribute("width") || 0);
		const height = parseFloat(element.getAttribute("height") || 0);

		bounds.update(x, y);
		bounds.update(x + width, y + height);
	}

	/**
	 * Update bounds for a circle element
	 * @param {Element} element - Circle element
	 * @param {Transform} transform - Transform values
	 * @param {Object} bounds - Bounds object
	 */
	static updateCircleBounds(element, transform, bounds) {
		const cx = parseFloat(element.getAttribute("cx") || 0) + transform.x;
		const cy = parseFloat(element.getAttribute("cy") || 0) + transform.y;
		const r = parseFloat(element.getAttribute("r") || 0);

		bounds.update(cx - r, cy - r);
		bounds.update(cx + r, cy + r);
	}

	/**
	 * Update bounds for a path element
	 * @param {Element} element - Path element
	 * @param {Transform} transform - Transform values
	 * @param {Object} bounds - Bounds object
	 */
	static updatePathBounds(element, transform, bounds) {
		const d = element.getAttribute("d");
		if (!d) return;

		const numbers = d.match(/[-+]?([0-9]*\.[0-9]+|[0-9]+)/g);
		if (!numbers) return;

		for (let i = 0; i < numbers.length; i += 2) {
			const x = parseFloat(numbers[i]) + transform.x;
			const y = parseFloat(numbers[i + 1]) + transform.y;
			bounds.update(x, y);
		}
	}

	/**
	 * Update bounds for a line element
	 * @param {Element} element - Line element
	 * @param {Transform} transform - Transform values
	 * @param {Object} bounds - Bounds object
	 */
	static updateLineBounds(element, transform, bounds) {
		const x1 = parseFloat(element.getAttribute("x1") || 0) + transform.x;
		const y1 = parseFloat(element.getAttribute("y1") || 0) + transform.y;
		const x2 = parseFloat(element.getAttribute("x2") || 0) + transform.x;
		const y2 = parseFloat(element.getAttribute("y2") || 0) + transform.y;

		bounds.update(x1, y1);
		bounds.update(x2, y2);
	}

	/**
	 * Update bounds for polyline/polygon elements
	 * @param {Element} element - Poly element
	 * @param {Transform} transform - Transform values
	 * @param {Object} bounds - Bounds object
	 */
	static updatePolyBounds(element, transform, bounds) {
		const points = element.getAttribute("points");
		if (!points) return;

		const coordinates = points
			.trim()
			.split(/[\s,]+/)
			.map(parseFloat);
		for (let i = 0; i < coordinates.length; i += 2) {
			if (i + 1 < coordinates.length) {
				const x = coordinates[i] + transform.x;
				const y = coordinates[i + 1] + transform.y;
				bounds.update(x, y);
			}
		}
	}

	/**
	 * Update bounds for text elements
	 * @param {Element} element - Text element
	 * @param {Transform} transform - Transform values
	 * @param {Object} bounds - Bounds object
	 */
	static updateTextBounds(element, transform, bounds) {
		const x = parseFloat(element.getAttribute("x") || 0) + transform.x;
		const y = parseFloat(element.getAttribute("y") || 0) + transform.y;
		// Add a reasonable estimate for text size
		const textLength = parseFloat(element.getAttribute("textLength")) || element.textContent.length * 8; // Rough estimate
		const fontSize = parseFloat(getComputedStyle(element).fontSize) || 16;

		bounds.update(x, y);
		bounds.update(x + textLength, y + fontSize);
	}

	/**
	 * Calculate dimensions for new SVG
	 * @param {BoundingBox} bbox - Bounding box
	 * @returns {Object} Calculated dimensions and viewBox
	 */
	static calculateDimensions(bbox) {
		// Add padding and round up to nearest pixel
		const padding = this.DEFAULT_PADDING;
		const width = Math.ceil(Math.max(1, bbox.width + padding * 2));
		const height = Math.ceil(Math.max(1, bbox.height + padding * 2));

		// Ensure the viewBox captures all content
		const viewBox = `${bbox.x - padding} ${bbox.y - padding} ${width} ${height}`;

		return { width, height, viewBox };
	}

	/**
	 * Generate SVG content
	 * @param {Element} group - Group element
	 * @param {string} defsContent - Defs content
	 * @param {string} viewBox - ViewBox attribute value
	 * @param {number} width - SVG width
	 * @param {number} height - SVG height
	 * @returns {string} Generated SVG content
	 */
	static generateSVGContent(group, defsContent, viewBox, width, height) {
		return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${this.SVG_NAMESPACE}" viewBox="${viewBox}" width="${width}" height="${height}">
${defsContent}
${group.outerHTML}
</svg>`;
	}

	/**
	 * Prompt user for SVG file path
	 * @returns {Promise<string>} The selected file path
	 */
	static async promptForSVGPath() {
		const answer = await inquirer.prompt([
			{
				type: "input",
				name: "filePath",
				message: "Enter the exact path to your SVG file:",
				validate: async (input) => {
					// Strip quotes from start and end if present
					const cleanPath = input.replace(/^["']|["']$/g, "");
					try {
						await fs.access(cleanPath);
						return cleanPath.toLowerCase().endsWith(".svg") || "Please enter a valid SVG file path";
					} catch {
						return "File does not exist. Please enter a valid path";
					}
				},
			},
		]);
		// Strip quotes from the final answer
		return answer.filePath.replace(/^["']|["']$/g, "");
	}
}

// Execute the SVG processing
async function main() {
	try {
		const inputFile = await SVGProcessor.promptForSVGPath();
		const outputDir = path.join(__dirname, "output");
		await SVGProcessor.processSVG(inputFile, outputDir);
	} catch (error) {
		console.error("Fatal error:", error);
		process.exit(1);
	}
}

main();
