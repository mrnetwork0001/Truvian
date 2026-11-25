import { Config } from "@remotion/cli/config";

// JPEG frames keep Studio and draft renders fast; the 4K master passes --image-format png.
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(95);
Config.setOverwriteOutput(true);
