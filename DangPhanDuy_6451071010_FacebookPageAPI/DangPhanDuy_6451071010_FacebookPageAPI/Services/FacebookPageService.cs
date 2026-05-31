using System.Text;
using System.Text.Json;
using Models;
using Microsoft.Extensions.Options;
using System.Runtime.CompilerServices;

namespace Services;

public class FacebookPageService
{
    private readonly HttpClient _httpClient;
    private readonly FacebookOptions _options;

    public FacebookPageService(HttpClient httpClient, IOptions<FacebookOptions> options)
    {
        _httpClient = httpClient;
        _options = options.Value;
    }

    private string BuildUrl(string path, Dictionary<string, string>? query = null)
    {
        var parameters = query ?? new Dictionary<string, string>();
        parameters["access_token"] = _options.PageAccessToken;

        var queryString = string.Join("&", parameters.Select(kv => $"{kv.Key}={Uri.EscapeDataString(kv.Value)}"));

        return $"{_options.BaseUrl.TrimEnd('/')}/{path}?{queryString}";
    }

    private async Task<string> GetFacebookAsync(string url)
    {
        Console.WriteLine("Facebook URL: " + url);

        var response = await _httpClient.GetAsync(url);
        var content = await response.Content.ReadAsStringAsync();

        Console.WriteLine("Facebook Status: " + response.StatusCode);
        Console.WriteLine("Facebook Body: " + content);

        return content;
    }

    public async Task<string> GetPageInfoAsync(string pageId)
    {
        var url = BuildUrl(pageId, new Dictionary<string, string>
        {
            ["fields"] = "id,name,about,fan_count,followers_count,link"
        });

        return await GetFacebookAsync(url);
    }

    public async Task<string> GetPagePostAsync(string pageId)
    {
        var url = BuildUrl($"{pageId}/posts", new Dictionary<string, string>
        {
            ["fields"] = "id,message,created_time,permalink_url"
        });

        return await GetFacebookAsync(url);
    }

    public async Task<string> CreatePostAsync(string pageId, string message)
    {
        var url = BuildUrl($"{pageId}/feed");

        var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["message"] = message
        });

        var response = await _httpClient.PostAsync(url, content);
        return await response.Content.ReadAsStringAsync();
    }

    public async Task<string> DeletePostAsync(string postId)
    {
        var url = BuildUrl(postId);

        var request = new HttpRequestMessage(HttpMethod.Delete, url);
        var response = await _httpClient.SendAsync(request);

        return await response.Content.ReadAsStringAsync();
    }

    public async Task<string> GetPostCommentsAsync(string postId)
    {
        var url = BuildUrl($"{postId}/comments", new Dictionary<string, string>
        {
            ["fields"] = "id,message,from,created_time"
        });

        return await _httpClient.GetStringAsync(url);
    }

    /// <summary>
    /// Ẩn một bình luận (is_hidden = true).
    /// Yêu cầu quyền: manage_pages hoặc pages_manage_engagement.
    /// </summary>
    public async Task<string> HideCommentAsync(string commentId)
    {
        var url = BuildUrl(commentId);

        var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["is_hidden"] = "true"
        });

        var response = await _httpClient.PostAsync(url, content);
        return await response.Content.ReadAsStringAsync();
    }

    /// <summary>
    /// Xóa một bình luận.
    /// Yêu cầu quyền: manage_pages hoặc pages_manage_engagement.
    /// </summary>
    public async Task<string> DeleteCommentAsync(string commentId)
    {
        var url = BuildUrl(commentId);

        var request = new HttpRequestMessage(HttpMethod.Delete, url);
        var response = await _httpClient.SendAsync(request);

        return await response.Content.ReadAsStringAsync();
    }

    public async Task<string> GetPostLikesAsync(string postId)
    {
        var url = BuildUrl($"{postId}/likes", new Dictionary<string, string>
        {
            ["summary"] = "true"
        });

        return await _httpClient.GetStringAsync(url);
    }

    public async Task<string> GetPageInsightsAsync(string pageId)
    {
        var url = BuildUrl($"{pageId}/insights", new Dictionary<string, string>
        {
            ["metric"] = "page_post_engagements", // Hoặc "page_impressions"
            ["access_token"] = "EAF3ajObhdawBRZAF5xWUfISQ8r6RcoO0nJZCnS3EF4ZChwGt8mFagDUFcoyqzJ36twH6FSJbPKTt45lERH3qVV4du4n7RUk575BTI3zqZArRSlxG8jsAfmJLoKcIx2vM3fhsmqy5yQ9PTiA8ewaeZAkqdangoJ04Nx9j0ELH22EdadT4ev2DbS5DccVtgvzsmrdbGmTTnRXJOiJ4aFEPBeskEPQCpwv2RVKUVZBym7IGnv6ZCjEOzr74p1csczadyulRCkcd9cvB14ZD"
        });

        // Thay vì: return await _httpClient.GetStringAsync(url);
        // Hãy dùng:
        var response = await _httpClient.GetAsync(url);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync();
            // Đặt một Breakpoint ở đây để xem giá trị của errorBody
            throw new Exception($"Facebook API Error: {errorBody}");
        }
        return await response.Content.ReadAsStringAsync();
    }
}