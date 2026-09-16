<?php

declare(strict_types=1);

$root = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'apps';
$iterator = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
);
$failures = 0;
$checked = 0;

foreach ($iterator as $file) {
    if (! $file->isFile() || 'php' !== strtolower($file->getExtension())) {
        continue;
    }

    ++$checked;
    $process = proc_open(
        [PHP_BINARY, '-l', $file->getPathname()],
        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes
    );
    if (! is_resource($process)) {
        fwrite(STDERR, "PHP lint process could not be started.\n");
        exit(1);
    }

    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exitCode = proc_close($process);
    if (0 !== $exitCode) {
        ++$failures;
        fwrite(STDERR, $stdout . $stderr);
    }
}

if (0 !== $failures) {
    fwrite(STDERR, sprintf("PHP lint failed for %d of %d files.\n", $failures, $checked));
    exit(1);
}

fwrite(STDOUT, sprintf("PHP syntax valid for %d files.\n", $checked));
